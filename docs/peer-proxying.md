# Peer Proxying

Peer proxying allows multiple test-runner instances on different machines to cooperate, presenting a unified set of build configs to the dashboard. **This is implemented.**

## Config

Add a `peers` array to `~/.test-runner/config.json` on the hub machine:

```json
{
  "port": 3000,
  "configs": [ ... ],
  "peers": [
    { "address": "192.168.1.12:3000" },
    { "address": "192.168.1.13:3000" }
  ]
}
```

Each peer runs the same test-runner server with its own local configs. No special configuration is needed on the peer — it's a regular test-runner instance.

## How It Works

- The hub connects to each peer's WebSocket on startup
- Receives their `configs` message to learn what configs they offer (including current revision)
- Caches this, reconnects automatically on failure (5s delay)
- Periodic ping/pong (30s) detects offline peers; their configs are removed from the aggregated list until reconnected

## Run Forwarding

When the hub receives a `run` request for a config not available locally:

1. Finds which peer has that config
2. Forwards the `run` message over the peer WebSocket connection
3. Relays `run_queued`, `run_started`, `run_completed`/`run_error` back to all dashboard clients

Peer run IDs are prefixed with the peer address using `~` as separator (e.g. `192.168.1.12:3000~a1b2c3`) to enable routing.

## Log/Profile Proxying

`GET /api/runs/:id/log` and `/profile` are proxied via HTTP to the peer that owns the run. The hub detects peer run IDs by the `~` prefix and routes accordingly.

## History

Completed peer runs are recorded in the hub's local `~/.test-runner/history.jsonl` alongside local runs. The `/api/history` endpoint serves them all together, with staleness checked against cached peer revisions.

## Architecture

```
Dashboard ──WS──► localhost:3000 (hub server)
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    local configs    WS to         WS to
    (linux64-opt,    peer          peer
     linux64-debug)
                  192.168.1.12   192.168.1.13
                  (macos-opt,    (win64-debug)
                   macos-debug)
```

## Future: MCP Integration

Thin MCP server (same process or separate entry point) on top of the WS/REST API:
- Reads config to know about local + peer machines
- Exposes tools to Claude sessions:
  - `reproduce_failure(test, config?)` — run a test, auto-select config if not specified
  - `check_patch_impact(patch_file, test, configs[])` — apply patch, run across configs
  - `list_configs()` — all available configs across all machines
- ~100-200 lines on top of the existing server
