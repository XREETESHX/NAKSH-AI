import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main

ORIGINAL_COMPLETE = main._complete


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setattr(main, "API_KEYS", ["first-secret", "second-secret"])
    monkeypatch.setattr(main, "SIMULATION_ENABLED", True)

    async def fake_complete(messages, simulated):
        if "*" in simulated or len(simulated) >= 2:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail="all providers unavailable")
        reply = "Paris is the capital of France." if "capital of France" in messages[-1]["content"] else "I remember Paris."
        return reply, {
            "resolution_source": "LIVE_INFERENCE",
            "model": "test/model",
            "latency_ms": 7,
            "input_tokens": 18,
            "output_tokens": 7,
            "key_id": "key_2" if simulated else "key_1",
            "fallback_attempts": 1 if simulated else 0,
        }

    monkeypatch.setattr(main, "_complete", fake_complete)
    with TestClient(main.app) as test_client:
        yield test_client


def test_health_and_chat_history(client):
    assert client.get("/health").json() == {"status": "ok", "keys_configured": 2, "cache_enabled": True}
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
    first = client.post("/chat", json={"session_id": "s-1", "message": "What is the capital of France?"})
    assert first.status_code == 200
    assert first.json()["metadata"]["input_tokens"] == 18
    second = client.post("/chat", json={"session_id": "s-1", "message": "Do you remember?"})
    assert second.status_code == 200
    history = client.get("/sessions/s-1/messages").json()["messages"]
    assert [message["role"] for message in history] == ["user", "assistant", "user", "assistant"]
    assert history[1]["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert client.get("/sessions/unknown/messages").status_code == 404


def test_sessions_are_isolated_and_system_prompt_is_private(client, monkeypatch):
    requests = []

    async def capture_complete(messages, simulated):
        requests.append(messages)
        return "A reply.", {
            "resolution_source": "LIVE_INFERENCE",
            "model": "test/model",
            "latency_ms": 1,
            "input_tokens": 5,
            "output_tokens": 2,
            "key_id": "key_1",
            "fallback_attempts": 0,
        }

    monkeypatch.setattr(main, "_complete", capture_complete)
    client.post("/chat", json={
        "session_id": "private-prompt",
        "message": "First turn",
        "system_prompt": "Answer in one sentence.",
    })
    client.post("/chat", json={"session_id": "separate-session", "message": "Isolated turn"})
    client.post("/chat", json={"session_id": "private-prompt", "message": "Second turn"})

    assert requests[0] == [
        {"role": "system", "content": "Answer in one sentence."},
        {"role": "user", "content": "First turn"},
    ]
    assert requests[1][0]["content"] == main.DEFAULT_SYSTEM_PROMPT
    assert len(requests[1]) == 2
    assert requests[2][0]["content"] == "Answer in one sentence."
    assert [item["role"] for item in requests[2]] == ["system", "user", "assistant", "user"]
    history = client.get("/sessions/private-prompt/messages").json()["messages"]
    assert all("system_prompt" not in item for item in history)


@pytest.mark.parametrize("payload", [
    {"session_id": "s", "message": "   "},
    {"session_id": "", "message": "hello"},
    {"session_id": "s", "message": "x" * 4001},
])
def test_invalid_messages_are_rejected(client, payload):
    assert client.post("/chat", json=payload).status_code == 422


def test_malformed_json_returns_json_422_without_stack_trace(client):
    response = client.post("/chat", content="{bad json", headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    assert "Traceback" not in response.text


def test_health_reports_missing_key_pool_as_json_503(client, monkeypatch):
    monkeypatch.setattr(main, "API_KEYS", [])
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json() == {"detail": "at least two provider keys are required"}


def test_health_reports_database_failure_as_json_503(client, tmp_path, monkeypatch):
    broken_database_path = tmp_path / "directory-is-not-a-database"
    broken_database_path.mkdir()
    monkeypatch.setattr(main, "DB_PATH", str(broken_database_path))
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json() == {"detail": "database unavailable"}


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_simulated_fallback_and_total_failure_leave_no_history(client, monkeypatch, status):
    monkeypatch.setattr(main, "_complete", ORIGINAL_COMPLETE)
    calls = []

    async def fake_acompletion(**kwargs):
        calls.append(kwargs["api_key"])
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Real generated answer."))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=4),
            _hidden_params={"cache_hit": False},
        )

    monkeypatch.setattr(main.litellm, "acompletion", fake_acompletion)
    response = client.post(
        "/chat", json={"session_id": "fallback", "message": "hello"},
        headers={"X-Simulate-Failure": f"key_1={status}"},
    )
    assert response.status_code == 200
    assert response.json()["metadata"]["key_id"] == "key_2"
    assert response.json()["metadata"]["fallback_attempts"] == 1
    assert calls == ["second-secret"]

    failure = client.post(
        "/chat", json={"session_id": "failed", "message": "hello"},
        headers={"X-Simulate-Failure": "*=429"},
    )
    assert failure.status_code == 503
    assert failure.json() == {"detail": "all providers unavailable"}
    assert client.get("/sessions/failed/messages").status_code == 404


@pytest.mark.parametrize(
    ("cache_hit", "source", "key_id", "fallbacks"),
    [(False, "LIVE_INFERENCE", "key_1", 0), (True, "LLM_CACHE", None, 0)],
)
def test_litellm_response_metadata(monkeypatch, cache_hit, source, key_id, fallbacks):
    monkeypatch.setattr(main, "API_KEYS", ["first-secret", "second-secret"])

    async def fake_acompletion(**kwargs):
        assert kwargs["caching"] is True
        assert kwargs["model"] == main.MODEL
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="A cached answer."))],
            usage=SimpleNamespace(prompt_tokens=13, completion_tokens=4),
            _hidden_params={"cache_hit": cache_hit},
        )

    monkeypatch.setattr(main.litellm, "acompletion", fake_acompletion)
    _, metadata = asyncio.run(main._complete([{"role": "user", "content": "hello"}], {}))
    assert metadata["resolution_source"] == source
    assert metadata["key_id"] == key_id
    assert metadata["fallback_attempts"] == fallbacks
    assert metadata["input_tokens"] == 13
    assert metadata["output_tokens"] == 4


def test_provider_exception_fails_over_to_next_key(monkeypatch):
    monkeypatch.setattr(main, "API_KEYS", ["first-secret", "second-secret"])
    calls = []

    async def fake_acompletion(**kwargs):
        calls.append(kwargs["api_key"])
        if kwargs["api_key"] == "first-secret":
            raise RuntimeError("simulated provider 429")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Recovered reply."))],
            usage=SimpleNamespace(prompt_tokens=12, completion_tokens=3),
            _hidden_params={"cache_hit": False},
        )

    monkeypatch.setattr(main.litellm, "acompletion", fake_acompletion)
    reply, metadata = asyncio.run(main._complete([{"role": "user", "content": "hello"}], {}))
    assert calls == ["first-secret", "second-secret"]
    assert reply == "Recovered reply."
    assert metadata["key_id"] == "key_2"
    assert metadata["fallback_attempts"] == 1


def test_all_provider_exceptions_return_clean_503(monkeypatch):
    monkeypatch.setattr(main, "API_KEYS", ["first-secret", "second-secret"])

    async def fake_acompletion(**kwargs):
        raise RuntimeError("provider detail that must not escape")

    monkeypatch.setattr(main.litellm, "acompletion", fake_acompletion)
    with pytest.raises(HTTPException) as error:
        asyncio.run(main._complete([{"role": "user", "content": "hello"}], {}))
    assert error.value.status_code == 503
    assert error.value.detail == "all providers unavailable"


def test_simulation_header_rejects_unknown_keys_and_statuses(monkeypatch):
    monkeypatch.setattr(main, "API_KEYS", ["first-secret", "second-secret"])
    monkeypatch.setattr(main, "SIMULATION_ENABLED", True)
    with pytest.raises(HTTPException) as unknown_key:
        main._simulation_map("key_3=429")
    assert unknown_key.value.status_code == 422
    with pytest.raises(HTTPException) as unknown_status:
        main._simulation_map("key_1=401")
    assert unknown_status.value.status_code == 422


def test_example_placeholders_are_not_counted_as_api_keys():
    assert main._parse_api_keys("replace_with_key_1, your_key_2,real-key,real-key") == ["real-key"]
