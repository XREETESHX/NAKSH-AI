# NAKSH AI

NAKSH AI is a full-stack, multi-turn chat app. It uses React and Vite for the frontend, FastAPI for the backend, SQLite for saved conversations, and LiteLLM for model requests, exact-response caching, and API-key failover.

## Features

- Multi-turn AI chat with optional session instructions.
- Saved conversation history: reopen a conversation or delete it from the sidebar.
- Exact-response cache and ordered provider-key failover.
- Per-response source, model, latency, and token metadata.
- Health status, session ID copy, and Docker Compose setup.

## Run locally with Docker Desktop

### Requirements

- Docker Desktop with Docker Compose enabled.
- Two valid Gemini API keys. The app expects at least two keys so it can check backend health and demonstrate key failover.

### Setup

Open PowerShell in the project folder and create a local environment file if you do not already have one:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Set `LLM_API_KEYS` to two comma-separated keys in `.env`. Keep the keys private and do not commit `.env`.

```dotenv
LLM_API_KEYS=your_first_key,your_second_key
```

Start the app:

```powershell
docker compose up --build -d
docker compose ps
```

Open the frontend at <http://localhost:3000>. Check the backend at <http://localhost:8000/health>.

Stop the containers while keeping saved conversations:

```powershell
docker compose down
```

The SQLite database is stored in a named Docker volume. `docker compose down -v` also removes that volume and permanently deletes the saved conversations.

## Use the app

1. Select **New conversation** and type a question in the message box. Press Enter or click Send.
2. Read the assistant answer and its response details: source (`LIVE_INFERENCE` or `LLM_CACHE`), model, latency, and token counts.
3. Send a follow-up in the same conversation to continue the context.
4. Select a conversation in the **History** list to reopen it.
5. Click a history row’s trash icon to delete that conversation immediately. The deletion removes the conversation and its messages from SQLite.
6. Use **System prompt** to add optional instructions for the current conversation. Starting a new conversation clears those instructions.

To demonstrate the cache, ask the same first-turn question in a new conversation while the backend remains running. The second answer should show `LLM_CACHE`. The cache is local to the backend process and clears when that process restarts.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `LLM_API_KEYS` | Comma-separated Gemini keys; at least two are required for `/health` | Empty |
| `LLM_MODEL` | LiteLLM model identifier | `gemini/gemini-3.5-flash-lite` |
| `LLM_TIMEOUT_SECONDS` | Timeout for each provider-key attempt | `20` |
| `DATABASE_URL` | SQLite database location | Compose sets `sqlite:////data/app.db` |
| `ALLOWED_ORIGINS` | Frontend origins allowed by backend CORS | `http://localhost:3000` in Compose |
| `ENABLE_FAILURE_SIMULATION` | Enables the test-only `X-Simulate-Failure` header | `true` in Compose |
| `VITE_API_BASE_URL` | Backend URL baked into the frontend at build time | `http://localhost:8000` |

Set `ENABLE_FAILURE_SIMULATION=false` in a production deployment. If `VITE_API_BASE_URL` changes, rebuild the frontend image because Vite reads this value at build time.

## Run without Docker on Windows

Use Python 3.11 or 3.12 and Node.js 22. In the first PowerShell window, from the repository root:

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt -r backend\requirements-dev.txt
$env:LLM_API_KEYS = "your_first_key,your_second_key"
$env:LLM_MODEL = "gemini/gemini-3.5-flash-lite"
$env:DATABASE_URL = "sqlite:///./app.db"
$env:ALLOWED_ORIGINS = "http://localhost:3000,http://localhost:5173"
$env:ENABLE_FAILURE_SIMULATION = "true"
Set-Location backend
uvicorn app.main:app --reload --port 8000
```

In a second PowerShell window, from the repository root:

```powershell
Set-Location frontend
npm ci
$env:VITE_API_BASE_URL = "http://localhost:8000"
npm run dev -- --host 0.0.0.0
```

Open <http://localhost:5173>. When using this mode, keep the backend's `ALLOWED_ORIGINS` set to include `http://localhost:5173`.

## Backend API

- `GET /health` — backend, database, configured-key count, and cache status. Returns an error if fewer than two keys are configured.
- `POST /chat` — send a message. Body: `{"session_id":"demo-1","message":"Hello"}`; optional `system_prompt` can be included.
- `GET /sessions?limit=50` — list recent saved conversations (maximum 100).
- `GET /sessions/{session_id}/messages` — retrieve one conversation's messages and assistant metadata.
- `DELETE /sessions/{session_id}` — delete a conversation and its messages. Repeating a delete is safe.

The API documentation routes are disabled in this assignment build. The chat response includes `reply` and `metadata` fields.

## Run the backend tests

From the repository root, after installing the development requirements:

```powershell
Set-Location backend
python -m pytest -q
```

The backend suite uses mocked model responses; it does not need live API keys. The frontend production build can be checked with `npm run build` from `frontend/`.

## Troubleshooting

- **The app says the backend is offline:** check `.env` has two valid, comma-separated keys, then run `docker compose logs --tail 100 backend`.
- **Chat returns a provider error:** check the keys and provider quota; inspect backend logs without sharing the keys.
- **Frontend cannot reach a deployed backend:** set `ALLOWED_ORIGINS` to the exact frontend origin and set `VITE_API_BASE_URL` to the backend base URL, then rebuild the frontend.
- **A service cannot start:** check whether ports 3000 or 8000 are already in use with `docker compose ps` and inspect `docker compose logs --tail 100 frontend backend`.
- **You want a fresh database:** `docker compose down -v` deletes all saved conversations along with the volume.

## Deployment and submission status

Public source repository: [XREETESHX/NAKSH-AI](https://github.com/XREETESHX/NAKSH-AI).

The project currently runs locally and does not have public frontend/backend deployment URLs or a recorded demo video. Do not present localhost addresses as public live URLs.
