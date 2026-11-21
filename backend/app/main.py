from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv

# Load workspace configuration for non-Docker runs; Compose supplies the same
# settings directly to the container environment.
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

# The app does not need LiteLLM's live pricing refresh, and the local map keeps
# startup independent of an optional metadata download.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import litellm
from litellm.caching.caching import Cache
from fastapi import FastAPI, Header, HTTPException, Path as ApiPath, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator


DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise assistant. Answer accurately and ask a clarifying question when needed."
MODEL = os.getenv("LLM_MODEL", "gemini/gemini-3.5-flash-lite")
SIMULATION_ENABLED = os.getenv("ENABLE_FAILURE_SIMULATION", "false").strip().lower() == "true"
logger = logging.getLogger(__name__)


def _parse_api_keys(raw: str) -> list[str]:
    keys = []
    for value in raw.split(","):
        key = value.strip()
        if not key or re.match(r"^(replace_with_|your_key|your_gemini_key)", key, flags=re.IGNORECASE):
            continue
        if key not in keys:
            keys.append(key)
    return keys


API_KEYS = _parse_api_keys(os.getenv("LLM_API_KEYS", ""))
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# LiteLLM's exact-match local cache is intentionally in-process: the assignment
# forbids external cache services. It keys on the full request payload.
litellm.cache = Cache(type="local")
litellm.suppress_debug_info = True
litellm.telemetry = False


def _database_path(url: str) -> str:
    if not url.startswith("sqlite:///"):
        raise RuntimeError("DATABASE_URL must use SQLite (sqlite:///path)")
    path = url[len("sqlite:///") :]
    if not path:
        raise RuntimeError("DATABASE_URL must include a database path")
    if path == ":memory:":
        raise RuntimeError("DATABASE_URL must point to a persistent SQLite file")
    # sqlite:////data/app.db contains an absolute Unix path after this prefix.
    return path if path.startswith("/") else str(Path(path).resolve())


DB_PATH = _database_path(DATABASE_URL)


def _connect() -> sqlite3.Connection:
    if DB_PATH != ":memory:":
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def _database() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _init_db() -> None:
    with _database() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                system_prompt TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id, id)")


@asynccontextmanager
async def lifespan(_: FastAPI):
    _init_db()
    yield


app = FastAPI(
    title="NAKSH AI",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Simulate-Failure"],
)


class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    session_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    system_prompt: str | None = Field(default=None, max_length=4000)

    @field_validator("session_id", "message", "system_prompt")
    @classmethod
    def reject_whitespace_only(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("must not be empty")
        return value


def _simulation_map(header: str | None) -> dict[str, int]:
    if not SIMULATION_ENABLED or not header:
        return {}
    result: dict[str, int] = {}
    valid_key_ids = {f"key_{index}" for index in range(1, len(API_KEYS) + 1)}
    for item in header.split(","):
        key, sep, raw_status = item.strip().partition("=")
        if not sep or not key or not raw_status.isdigit() or int(raw_status) not in {429, 500, 502, 503}:
            raise HTTPException(status_code=422, detail="invalid X-Simulate-Failure header")
        if key != "*" and key not in valid_key_ids:
            raise HTTPException(status_code=422, detail="invalid X-Simulate-Failure key id")
        result[key] = int(raw_status)
    return result


def _usage_value(usage: Any, primary: str, alternate: str) -> int | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        value = usage.get(primary, usage.get(alternate))
    else:
        value = getattr(usage, primary, getattr(usage, alternate, None))
    try:
        return max(0, int(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


async def _complete(messages: list[dict[str, str]], simulated: dict[str, int]) -> tuple[str, dict[str, Any]]:
    if len(API_KEYS) < 2:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    request_started = time.perf_counter()
    failures = 0
    for index, key in enumerate(API_KEYS, start=1):
        key_id = f"key_{index}"
        if "*" in simulated or key_id in simulated:
            failures += 1
            continue
        try:
            response = await litellm.acompletion(
                model=MODEL,
                messages=messages,
                api_key=key,
                temperature=0.3,
                caching=True,
                num_retries=0,
                timeout=float(os.getenv("LLM_TIMEOUT_SECONDS", "20")),
            )
            elapsed_ms = max(0, int((time.perf_counter() - request_started) * 1000))
            reply = str(response.choices[0].message.content or "").strip()
            if not reply:
                raise RuntimeError("provider returned an empty response")
            hidden = getattr(response, "_hidden_params", {}) or {}
            cache_hit = bool(hidden.get("cache_hit", False))
            usage = getattr(response, "usage", None)
            input_tokens = _usage_value(usage, "prompt_tokens", "input_tokens")
            output_tokens = _usage_value(usage, "completion_tokens", "output_tokens")
            if input_tokens is None:
                try:
                    input_tokens = litellm.token_counter(model=MODEL, messages=messages)
                except Exception:
                    input_tokens = max(1, sum(len(message["content"]) for message in messages) // 4)
            if output_tokens is None:
                try:
                    output_tokens = litellm.token_counter(model=MODEL, text=reply)
                except Exception:
                    output_tokens = max(1, len(reply) // 4)
            return reply, {
                "resolution_source": "LLM_CACHE" if cache_hit else "LIVE_INFERENCE",
                "model": MODEL,
                "latency_ms": elapsed_ms,
                "input_tokens": int(input_tokens),
                "output_tokens": int(output_tokens),
                "key_id": None if cache_hit else key_id,
                "fallback_attempts": 0 if cache_hit else failures,
            }
        except Exception as error:
            # Keep credentials and provider messages out of both client responses
            # and logs; the key id, exception class, and HTTP status are enough
            # to diagnose a failing provider attempt.
            response = getattr(error, "response", None)
            status_code = getattr(error, "status_code", None) or getattr(response, "status_code", None)
            missing_module = getattr(error, "name", None) if isinstance(error, ModuleNotFoundError) else None
            logger.warning(
                "Provider attempt failed for %s (error_type=%s, status_code=%s, missing_module=%s)",
                key_id,
                type(error).__name__,
                status_code,
                missing_module,
            )
            failures += 1
    raise HTTPException(status_code=503, detail="all providers unavailable")


@app.get("/health")
async def health() -> dict[str, Any]:
    if len(API_KEYS) < 2:
        raise HTTPException(status_code=503, detail="at least two provider keys are required")
    try:
        with _database() as conn:
            conn.execute("SELECT 1").fetchone()
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")
    return {"status": "ok", "keys_configured": len(API_KEYS), "cache_enabled": True}


@app.post("/chat")
async def chat(
    payload: ChatRequest,
    x_simulate_failure: str | None = Header(default=None, alias="X-Simulate-Failure"),
) -> dict[str, Any]:
    simulated = _simulation_map(x_simulate_failure)
    try:
        with _database() as conn:
            session = conn.execute(
                "SELECT system_prompt FROM sessions WHERE session_id = ?", (payload.session_id,)
            ).fetchone()
            history = conn.execute(
                "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC", (payload.session_id,)
            ).fetchall()
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")

    system_prompt = payload.system_prompt or (session["system_prompt"] if session else DEFAULT_SYSTEM_PROMPT)
    llm_messages = [{"role": "system", "content": system_prompt}]
    llm_messages.extend({"role": row["role"], "content": row["content"]} for row in history)
    llm_messages.append({"role": "user", "content": payload.message})
    reply, metadata = await _complete(llm_messages, simulated)

    created_at = datetime.now(timezone.utc).isoformat()
    try:
        with _database() as conn:
            conn.execute(
                "INSERT INTO sessions(session_id, system_prompt, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET system_prompt = excluded.system_prompt",
                (payload.session_id, system_prompt, created_at),
            )
            conn.execute(
                "INSERT INTO messages(session_id, role, content, metadata, created_at) VALUES (?, 'user', ?, NULL, ?)",
                (payload.session_id, payload.message, created_at),
            )
            conn.execute(
                "INSERT INTO messages(session_id, role, content, metadata, created_at) VALUES (?, 'assistant', ?, ?, ?)",
                (payload.session_id, reply, json.dumps(metadata), created_at),
            )
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")
    return {"session_id": payload.session_id, "reply": reply, "metadata": metadata}


@app.get("/sessions")
async def list_sessions(limit: int = Query(default=50, ge=1, le=100)) -> dict[str, Any]:
    try:
        with _database() as conn:
            rows = conn.execute(
                """SELECT s.session_id, s.created_at,
                          (SELECT substr(m.content, 1, 120) FROM messages m
                           WHERE m.session_id = s.session_id AND m.role = 'user'
                           ORDER BY m.id ASC LIMIT 1) AS preview,
                          (SELECT m.created_at FROM messages m
                           WHERE m.session_id = s.session_id
                           ORDER BY m.id DESC LIMIT 1) AS updated_at,
                          (SELECT COUNT(*) FROM messages m
                           WHERE m.session_id = s.session_id) AS message_count
                   FROM sessions s
                   WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id)
                   ORDER BY (SELECT MAX(m.id) FROM messages m
                             WHERE m.session_id = s.session_id) DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")
    return {
        "sessions": [
            {
                "session_id": row["session_id"],
                "preview": row["preview"] or "Conversation",
                "created_at": row["created_at"],
                "updated_at": row["updated_at"] or row["created_at"],
                "message_count": row["message_count"],
            }
            for row in rows
        ]
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str = ApiPath(min_length=1, max_length=128)) -> dict[str, Any]:
    try:
        with _database() as conn:
            exists = conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
            if exists:
                conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
                conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")
    return {"session_id": session_id, "deleted": bool(exists)}


@app.get("/sessions/{session_id}/messages")
async def get_messages(session_id: str = ApiPath(min_length=1, max_length=128)) -> dict[str, Any]:
    try:
        with _database() as conn:
            exists = conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="session not found")
            rows = conn.execute(
                "SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY id ASC", (session_id,)
            ).fetchall()
    except (sqlite3.Error, OSError):
        raise HTTPException(status_code=503, detail="database unavailable")
    messages = []
    for row in rows:
        item: dict[str, Any] = {"role": row["role"], "content": row["content"]}
        if row["role"] == "assistant" and row["metadata"]:
            item["metadata"] = json.loads(row["metadata"])
        messages.append(item)
    return {"session_id": session_id, "messages": messages}
