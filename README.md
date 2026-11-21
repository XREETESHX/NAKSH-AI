# Lyftr AI Chat

A full-stack, multi-turn AI chat app with LiteLLM exact-response caching, ordered API-key failover, per-request usage metadata, and SQLite-backed session history.

## 1. Live URLs

- Frontend: not deployed yet. Set `VITE_API_BASE_URL` to the public backend URL when building the frontend.
- Backend: not deployed yet. The service exposes `/health`, `/chat`, and `/sessions/{session_id}/messages`.
- Public repository and demo video: add these after publishing the repository and recording the walkthrough.

This workspace contains a deployment-ready project. It does not include provider keys, a hosting account, a public repository, or a recorded video, so public URLs cannot be claimed until those are configured.

## 2. Run locally: with Docker and without

### With Docker

1. Copy `.env.example` to `.env` and set `LLM_API_KEYS` to at least two valid Gemini API keys. Keep the keys comma-separated and never commit `.env`. The stack can start without keys, but chat and health checks will stay unavailable until two are configured.
2. Run `make up` from the repository root.
3. Open the frontend at <http://localhost:3000>. The API is at <http://localhost:8000>.
4. Stop the stack with `make down`.

Docker Compose stores SQLite at `/data/app.db` on the named `lyftr_data` volume. The volume survives container restarts. `docker compose down -v` deletes it.

### Without Docker

The backend reads the repository-root `.env` file for local runs. Use `DATABASE_URL=sqlite:///./app.db` and include `http://localhost:5173` in `ALLOWED_ORIGINS` for the Vite dev server.

Backend:

```bash
cd backend
python -m venv .venv
# Activate .venv, then:
pip install -r requirements.txt
export LLM_API_KEYS="key_one,key_two"
export LLM_MODEL="gemini/gemini-3.8-flash"
export DATABASE_URL="sqlite:///./app.db"
export ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173"
export ENABLE_FAILURE_SIMULATION="true"
uvicorn app.main:app --reload --port 8000
```

On Windows PowerShell, use `$env:LLM_API_KEYS="key_one,key_two"` and the matching `$env:` form for each variable. Start the frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

The Vite development server is available at <http://localhost:5173>. Add that origin to `ALLOWED_ORIGINS` for this mode. `VITE_API_BASE_URL` defaults to `http://localhost:8000`.

## 3. Design decisions: key fallback, caching, SQLite session storage

- **Fallback:** `LLM_API_KEYS` is read in order and mapped to `key_1`, `key_2`, etc. LiteLLM is called once per key, with a 20-second timeout per attempt by default (`LLM_TIMEOUT_SECONDS`); a failed attempt advances to the next key. If all keys fail, the route returns `503 {"detail":"all providers unavailable"}`. Server logs include only the key ID, error class, and HTTP status, never the key or provider error text.
- **Caching:** LiteLLM's local exact-match cache is enabled. The full model request, including system prompt and saved conversation history, is sent to LiteLLM. A recognized cache hit returns the cached reply and cached per-call usage with `resolution_source: "LLM_CACHE"`, `key_id: null`, and zero fallback attempts. Cache state is process-local, as required by the SQLite-only/no-Redis constraint.
- **SQLite:** the app creates its `sessions` and `messages` tables and session index on startup. It stores the chosen system prompt separately from the visible history. User and assistant rows are committed only after a successful model response, so failed requests do not create a session or partial turn. System prompts are not returned by the history endpoint.
- **Tokens and timing:** provider-reported prompt and completion usage is returned for this request, not accumulated over the session. A tokenizer fallback is used only if a provider omits usage. Latency is measured around the LiteLLM request.
- **Simulation:** `X-Simulate-Failure` is honored only when `ENABLE_FAILURE_SIMULATION=true`. It skips matching keys for that request, allowing real model inference through the next healthy configured key.
- **Model:** defaults to `gemini/gemini-3.5-flash-lite`, a lower-latency model for routine chat. `LLM_MODEL` can select another LiteLLM-supported model.

## 4. Verification: how to see failover, cache hits and per-message token usage

Install `backend/requirements-dev.txt`, then run `pytest` from `backend/` for the API contract, validation, session persistence, provider failover, simulation header, cache metadata, and error-history behavior. The tests mock model output and do not require API keys.

With the app running and two real keys configured:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"demo-1","message":"What is the capital of France?"}'
```

Repeat that same first message under a different session ID to see the exact cache hit. Its reply and token usage should match, `resolution_source` should be `LLM_CACHE`, and `key_id` should be `null`.

Force the first key to fail while allowing the next real key to answer:

```bash
curl -X POST http://localhost:8000/chat -H 'Content-Type: application/json' \
  -H 'X-Simulate-Failure: key_1=429' \
  -d '{"session_id":"demo-fallback","message":"Give me a one sentence greeting."}'
```

The response should show `key_id: "key_2"` and one fallback attempt. Simulate total failure and verify no history was saved:

```bash
curl -i -X POST http://localhost:8000/chat -H 'Content-Type: application/json' \
  -H 'X-Simulate-Failure: *=429' \
  -d '{"session_id":"demo-failed","message":"This turn should not be stored."}'
curl -i http://localhost:8000/sessions/demo-failed/messages
```

Assistant cards in the UI display resolution source, model, latency, input tokens, and output tokens for that reply. The history endpoint returns only user/assistant content and assistant metadata, oldest first.

## 5. Setup Used: your editor and AI tools

- Editor: Codex desktop workspace.
- AI tools: OpenAI Codex.
- Frameworks and libraries: React, Vite, FastAPI, LiteLLM, SQLite, Docker Compose.

## 6. Bonus features (if any): what you added beyond the requirements and why

- Optional session-level system prompt, persisted with the session but excluded from visible history.
- UI health indicator, suggested prompts, session ID copy affordance, and an explicit fallback-recovered status.
- Sessions table and transaction-safe turn writes to preserve prompt configuration and avoid partial history.

## Deployment checklist

1. Set `LLM_API_KEYS` in the backend host secret manager to two valid keys. Set `ENABLE_FAILURE_SIMULATION=true` as required by the assignment.
2. Deploy the backend container with persistent storage mounted at `/data`; set `DATABASE_URL=sqlite:////data/app.db` and `ALLOWED_ORIGINS` to the exact public frontend origin.
3. Build and deploy the frontend with `VITE_API_BASE_URL` set to the public backend base URL.
4. Verify `/health`, a live chat, a repeated first-message cache hit, simulated key failover, and total simulated failure from the deployed URLs.
5. Publish this project to a public GitHub repository and record a 2–3 minute demo. Replace the pending entries in “Live URLs” with the actual links.
