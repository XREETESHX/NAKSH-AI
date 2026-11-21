# NAKSH AI

NAKSH AI is a full-stack chat application with a React and TypeScript frontend, a FastAPI backend, and SQLite conversation storage. Model requests use LiteLLM, with response caching and provider-key failover.

## Features

- Multi-turn conversations with saved history
- Reopen or delete saved conversations
- Optional system prompt for each conversation
- Response metadata, including model, source, latency, and token counts
- Health endpoint and Docker Compose setup

## Requirements

- Docker Desktop with Docker Compose
- Two valid Gemini API keys for provider failover

## Run with Docker

From the project directory, create your local environment file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `LLM_API_KEYS` in `.env` to two comma-separated Gemini API keys. Keep this file private; it is excluded from Git.

Start the app:

```powershell
docker compose up --build -d
```

Open the frontend at <http://localhost:3000>. The backend health check is at <http://localhost:8000/health>.

Stop the app while retaining saved conversations:

```powershell
docker compose down
```

The database is stored in a Docker volume. To remove it and all saved conversations, run `docker compose down -v`.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `LLM_API_KEYS` | Two comma-separated Gemini API keys | — |
| `LLM_MODEL` | LiteLLM model name | `gemini/gemini-3.5-flash-lite` |
| `LLM_TIMEOUT_SECONDS` | Timeout per provider attempt | `20` |
| `DATABASE_URL` | SQLite connection URL | Compose uses `sqlite:////data/app.db` |
| `ALLOWED_ORIGINS` | Allowed frontend origins | `http://localhost:3000` |
| `ENABLE_FAILURE_SIMULATION` | Enable the test-only failure simulation header | `true` in Compose |
| `VITE_API_BASE_URL` | Backend base URL used by the frontend build | `http://localhost:8000` |

Set `ENABLE_FAILURE_SIMULATION=false` for a production deployment. Rebuild the frontend after changing `VITE_API_BASE_URL`.

## API

- `GET /health` — backend and database status
- `POST /chat` — send a message; accepts `session_id`, `message`, and optional `system_prompt`
- `GET /sessions?limit=50` — list saved conversations
- `GET /sessions/{session_id}/messages` — retrieve conversation messages
- `DELETE /sessions/{session_id}` — delete a conversation and its messages

## Tests

Backend tests use mocked model responses and do not require API keys:

```powershell
Set-Location backend
python -m pytest -q
```

Build the frontend from its directory:

```powershell
Set-Location frontend
npm ci
npm run build
```
