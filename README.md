# test-runner

Local service that lets a web dashboard trigger `mach test` runs on locally available build configs and retrieve results. Communication is via WebSocket (run requests + real-time notifications) and REST (fetching logs, profiles, and history).

Multiple machines can be linked as peers: a hub instance aggregates all configs and proxies runs and artifacts transparently.

## Setup

```bash
npm install
npm run build
```

### Register build configs

After building Firefox at least once, register each source tree:

```bash
node add-config.js /path/to/firefox
```

The script finds all `obj-*` directories with a `mozinfo.json`, detects the OS, architecture, and build type (opt/debug), and adds entries to `~/.test-runner/config.json` (creating it if needed). Run it once per source tree; duplicate entries are skipped.

You can also edit `~/.test-runner/config.json` directly:

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

### Run

```bash
npm start
```

A built-in dashboard is available at `http://localhost:3000`.

## Peer Proxying

To pool build configs across multiple machines, add a `peers` array to the hub's config pointing at other test-runner instances:

```json
{
  "port": 3000,
  "configs": [ ... ],
  "peers": [
    { "address": "192.168.1.117:3000" }
  ]
}
```

Each peer runs the same `test-runner` server with its own local configs. The hub connects to each peer on startup, aggregates their configs, and presents a single unified list to the dashboard. Run requests for peer configs are forwarded over WebSocket; log and profile artifacts are proxied transparently via HTTP.

Peers reconnect automatically if a connection drops.

## WebSocket Protocol

Connect to `ws://localhost:<port>`.

### Server → Client

On connection, the server sends available configs (local + any connected peers):

```json
{ "type": "configs", "configs": [{ "name": "linux64-opt" }, { "name": "macos-opt" }] }
```

Run lifecycle notifications:

```json
{ "type": "run_queued",   "request_id": "req-1", "run_id": "a1b2c3", "test": "...", "config": "linux64-opt" }
{ "type": "run_started",  "run_id": "a1b2c3", "test": "...", "config": "linux64-opt" }
{ "type": "run_completed","run_id": "a1b2c3", "request_id": "req-1", "config": "linux64-opt", "test": "...", "status": "PASS", "reproduced": false, "duration_seconds": 12, "exit_code": 0, "summary": "1 passed, 0 failed" }
{ "type": "run_error",    "run_id": "a1b2c3", "request_id": "req-1", "error": "mach test timed out after 600s" }
```

Peer run IDs are prefixed with the peer address (e.g. `192.168.1.117:3000~a1b2c3`).

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
| `GET /api/runs/:id/log` | Raw structured log (NDJSON). Add `?format=text` for plain text. |
| `GET /api/runs/:id/profile` | Gecko profiler JSON |
| `GET /api/history` | All completed runs from `~/.test-runner/history.jsonl` with staleness flag |

For peer runs, `:id` is a prefixed ID like `192.168.1.117:3000~a1b2c3`; the hub proxies the request automatically.

## How It Works

1. Dashboard connects via WebSocket, receives aggregated build configs (local + peers)
2. Dashboard sends a `run` request specifying a test path and config
3. If the config is local: server spawns `./mach test <path> --headless --log-raw=<tmpfile>` in the config's source tree
4. If the config belongs to a peer: run request is forwarded to the peer over its WebSocket connection
5. Server sends `run_queued` → `run_started` → `run_completed`/`run_error` over WebSocket to all connected clients
6. Raw log is parsed for `test_end` actions to determine pass/fail and whether a failure was reproduced
7. Log and profile artifacts are stored in `~/.test-runner/runs/<run_id>/` for later retrieval via REST (proxied for peer runs)

## Future Work

See [docs/peer-proxying.md](docs/peer-proxying.md) for the planned MCP integration phase.
