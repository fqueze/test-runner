import { Router, Request, Response } from "express";
import * as fs from "fs";
import { getRun, readHistory } from "./run-store";
import { AppConfig, HistoryEntryWithStaleness } from "./types";
import { getRevision } from "./revision";

export function createRoutes(config: AppConfig): Router {
const router = Router();

router.get("/api/runs/:id/log", (req: Request, res: Response) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!run.log_path || !fs.existsSync(run.log_path)) {
    res.status(404).json({ error: "Log not available" });
    return;
  }

  const asText = req.query.format === "text";
  res.setHeader("Content-Type", asText ? "text/plain; charset=utf-8" : "application/x-ndjson");
  const stream = fs.createReadStream(run.log_path);
  stream.pipe(res);
});

router.get("/api/runs/:id/profile", (req: Request, res: Response) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!run.profile_path || !fs.existsSync(run.profile_path)) {
    res.status(404).json({ error: "Profile not available" });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  const stream = fs.createReadStream(run.profile_path);
  stream.pipe(res);
});

router.get("/api/history", (_req: Request, res: Response) => {
  // Resolve current revision for each config
  const currentRevisions = new Map<string, string>();
  for (const c of config.configs) {
    currentRevisions.set(c.name, getRevision(c.mozilla_src));
  }

  const history = readHistory();
  const runs: HistoryEntryWithStaleness[] = history.map((entry) => ({
    ...entry,
    stale: entry.revision !== currentRevisions.get(entry.config),
  }));

  res.json({ runs });
});

router.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML);
});

return router;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Runner</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 24px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .ws-status { font-size: 0.8rem; margin-bottom: 16px; }
  .ws-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .ws-dot.connected { background: #2e7d32; }
  .ws-dot.disconnected { background: #c62828; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 16px; }
  .configs { margin-bottom: 16px; font-size: 0.85rem; }
  .configs span { display: inline-block; background: #e3f2fd; color: #1565c0; padding: 2px 8px; border-radius: 3px; margin-right: 6px; }
  h2 { font-size: 1.1rem; margin: 24px 0 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }
  th { background: #f0f0f0; text-align: left; padding: 10px 12px; font-size: 0.8rem; text-transform: uppercase; color: #666; }
  td { padding: 8px 12px; border-top: 1px solid #eee; font-size: 0.85rem; }
  tr:hover td { background: #fafafa; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: #e3f2fd; }
  .pass { color: #2e7d32; font-weight: 600; }
  .fail { color: #c62828; font-weight: 600; }
  .error { color: #e65100; font-weight: 600; }
  .queued { color: #757575; }
  .running { color: #1565c0; }
  .stale { opacity: 0.5; }
  .tag { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; }
  .tag-stale { background: #fff3e0; color: #e65100; }
  .tag-current { background: #e8f5e9; color: #2e7d32; }
  .empty { color: #999; text-align: center; padding: 32px; }
  .test-path { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .test-path:hover { white-space: normal; word-break: break-all; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .pulse { animation: pulse 1.5s ease-in-out infinite; }
</style>
</head>
<body>
<h1>Test Runner</h1>
<div class="ws-status"><span class="ws-dot disconnected" id="ws-dot"></span><span id="ws-label">Disconnected</span></div>
<div class="configs" id="configs"></div>

<h2>Active Runs</h2>
<table>
  <thead>
    <tr><th>Run ID</th><th>Test</th><th>Config</th><th>Status</th></tr>
  </thead>
  <tbody id="active-tbody">
    <tr><td colspan="4" class="empty">No active runs</td></tr>
  </tbody>
</table>

<h2>History</h2>
<div class="meta" id="meta">Loading...</div>
<table>
  <thead>
    <tr>
      <th>Run ID</th>
      <th>Test</th>
      <th>Config</th>
      <th>Status</th>
      <th>Reproduced</th>
      <th>Duration</th>
      <th>Finished</th>
      <th>Fresh</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>

<script>
const activeRuns = new Map();

function renderActive() {
  const tbody = document.getElementById('active-tbody');
  if (activeRuns.size === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No active runs</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const [id, r] of activeRuns) {
    const tr = document.createElement('tr');
    const statusCls = r.status === 'queued' ? 'queued' : 'running';
    const statusText = r.status === 'queued' ? 'Queued' : 'Running...';
    const pulseClass = r.status === 'running' ? ' pulse' : '';
    tr.innerHTML =
      '<td><code>' + id + '</code></td>' +
      '<td class="test-path" title="' + (r.test || '') + '">' + (r.test || '?') + '</td>' +
      '<td>' + (r.config || '?') + '</td>' +
      '<td class="' + statusCls + pulseClass + '">' + statusText + '</td>';
    tbody.appendChild(tr);
  }
}

// WebSocket connection
function connectWs() {
  const ws = new WebSocket('ws://' + location.host);
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  const configsEl = document.getElementById('configs');

  ws.onopen = () => {
    dot.className = 'ws-dot connected';
    label.textContent = 'Connected';
  };

  ws.onclose = () => {
    dot.className = 'ws-dot disconnected';
    label.textContent = 'Disconnected — reconnecting...';
    setTimeout(connectWs, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'configs') {
      configsEl.innerHTML = 'Configs: ' + msg.configs.map(c => '<span>' + c.name + '</span>').join('');
    }

    if (msg.type === 'run_queued') {
      activeRuns.set(msg.run_id, { status: 'queued', request_id: msg.request_id, test: msg.test, config: msg.config });
      renderActive();
    }

    if (msg.type === 'run_started') {
      const r = activeRuns.get(msg.run_id);
      if (r) {
        r.status = 'running';
        r.test = msg.test;
        r.config = msg.config;
      }
      renderActive();
    }

    if (msg.type === 'run_completed') {
      activeRuns.delete(msg.run_id);
      renderActive();
      // Prepend to history table
      addHistoryRow({
        run_id: msg.run_id,
        test: msg.test,
        config: msg.config,
        status: msg.status,
        reproduced: msg.reproduced,
        duration_seconds: msg.duration_seconds,
        finished_at: new Date().toISOString(),
        stale: false,
      });
    }

    if (msg.type === 'run_error') {
      activeRuns.delete(msg.run_id);
      renderActive();
    }
  };
}

function openProfiler(runId, test, config) {
  const profileUrl = location.origin + '/api/runs/' + runId + '/profile';
  const testName = test.split('/').pop();
  const profileName = 'mach test ' + testName + ' (' + config + ')';
  const profilerUrl = 'https://profiler.firefox.com/from-url/' +
    encodeURIComponent(profileUrl) +
    '/?profileName=' + encodeURIComponent(profileName);
  window.open(profilerUrl, '_blank');
}

function makeRowClickable(tr, runId, test, config) {
  tr.classList.add('clickable');
  tr.title = 'Click: Firefox Profiler | Alt+Click: raw log';
  tr.addEventListener('click', (e) => {
    if (e.altKey) {
      window.open('/api/runs/' + runId + '/log?format=text', '_blank');
    } else {
      openProfiler(runId, test, config);
    }
  });
}

function addHistoryRow(r) {
  const tbody = document.getElementById('tbody');
  // Remove "no runs" placeholder
  const empty = tbody.querySelector('.empty');
  if (empty) empty.parentElement.remove();

  const tr = document.createElement('tr');
  const statusCls = r.status === 'PASS' ? 'pass' : r.status === 'FAIL' ? 'fail' : 'error';
  const finished = r.finished_at ? new Date(r.finished_at).toLocaleString() : '-';
  tr.innerHTML =
    '<td><code>' + r.run_id + '</code></td>' +
    '<td class="test-path" title="' + r.test + '">' + r.test + '</td>' +
    '<td>' + r.config + '</td>' +
    '<td class="' + statusCls + '">' + r.status + '</td>' +
    '<td>' + (r.reproduced ? 'Yes' : 'No') + '</td>' +
    '<td>' + r.duration_seconds + 's</td>' +
    '<td>' + finished + '</td>' +
    '<td><span class="tag tag-current">current</span></td>';
  makeRowClickable(tr, r.run_id, r.test, r.config);
  tbody.insertBefore(tr, tbody.firstChild);

  // Update count
  const meta = document.getElementById('meta');
  const count = tbody.querySelectorAll('tr').length;
  meta.textContent = count + ' run(s)';
}

// Load history
(async () => {
  const tbody = document.getElementById('tbody');
  const meta = document.getElementById('meta');
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const runs = data.runs;
    if (runs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No runs yet</td></tr>';
      meta.textContent = '0 runs';
    } else {
      runs.reverse();
      meta.textContent = runs.length + ' run(s)';
      for (const r of runs) {
        const tr = document.createElement('tr');
        if (r.stale) tr.classList.add('stale');
        const statusCls = r.status === 'PASS' ? 'pass' : r.status === 'FAIL' ? 'fail' : r.status === 'ERROR' ? 'error' : 'error';
        const freshTag = r.stale
          ? '<span class="tag tag-stale">stale</span>'
          : '<span class="tag tag-current">current</span>';
        const finished = r.finished_at ? new Date(r.finished_at).toLocaleString() : '-';
        tr.innerHTML =
          '<td><code>' + r.run_id + '</code></td>' +
          '<td class="test-path" title="' + r.test + '">' + r.test + '</td>' +
          '<td>' + r.config + '</td>' +
          '<td class="' + statusCls + '">' + r.status + '</td>' +
          '<td>' + (r.reproduced ? 'Yes' : 'No') + '</td>' +
          '<td>' + r.duration_seconds + 's</td>' +
          '<td>' + finished + '</td>' +
          '<td>' + freshTag + '</td>';
        makeRowClickable(tr, r.run_id, r.test, r.config);
        tbody.appendChild(tr);
      }
    }
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Failed to load: ' + e.message + '</td></tr>';
    meta.textContent = 'Error';
  }

  connectWs();
})();
</script>
</body>
</html>`;

