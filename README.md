# test-runner

Local service that lets a web dashboard trigger `mach test` runs on locally available build configs and retrieve results. Communication is via WebSocket (run requests + real-time notifications) and REST (fetching logs, profiles, and history).

## Setup

```bash
npm install
npm run build
```

### Configuration

Create `~/.test-runner/config.json`:

```json
{
  "port": 3000,
  "configs": [
    {
      "name": "linux64-opt",
      "mozilla_src": "/path/to/firefox",
      "obj_dir": "obj-x86_64-pc-linux-gnu"
    }
  ]
}
```

Each config entry points at a Firefox source tree where `./mach test` can be run.

### Run

```bash
npm start
```

## WebSocket Protocol

Connect to `ws://localhost:<port>`.

### Server → Client

On connection, the server sends available configs:

```json
{ "type": "configs", "configs": [{ "name": "linux64-opt" }] }
```

Run lifecycle notifications:

```json
{ "type": "run_queued", "request_id": "req-1", "run_id": "a1b2c3" }
{ "type": "run_started", "run_id": "a1b2c3" }
{ "type": "run_completed", "run_id": "a1b2c3", "request_id": "req-1", "config": "linux64-opt", "test": "...", "status": "PASS", "reproduced": false, "duration_seconds": 12, "exit_code": 0, "summary": "1 passed, 0 failed" }
{ "type": "run_error", "run_id": "a1b2c3", "request_id": "req-1", "error": "mach test timed out after 600s" }
```

### Client → Server

Request a test run:

```json
{
  "type": "run",
  "request_id": "req-1",
  "test": "browser/base/content/test/performance/browser_startup.js",
  "config": "linux64-opt",
  "extra_args": ["--headless"]
}
```

## REST API

| Endpoint | Description |
|---|---|
| `GET /api/runs/:id/log` | Raw structured log (NDJSON, `application/x-ndjson`) |
| `GET /api/runs/:id/profile` | Gecko profiler JSON (`application/json`) |
| `GET /api/history` | All completed runs from `~/.test-runner/history.jsonl` |

## How It Works

1. Dashboard connects via WebSocket, receives available build configs
2. Dashboard sends a `run` request specifying a test path and config
3. Server spawns `./mach test <path> --headless --log-raw=<tmpfile>` in the config's source tree
4. Server sends `run_queued` → `run_started` → `run_completed`/`run_error` over WebSocket
5. Raw log is parsed for `test_end` actions to determine pass/fail and whether a failure was reproduced
6. Log and profile artifacts are stored in `~/.test-runner/runs/<run_id>/` for later retrieval via REST

## Future Work

See [docs/peer-proxying.md](docs/peer-proxying.md) for the planned peer proxying and MCP integration phases.
