import { Router, Request, Response } from "express";
import * as fs from "fs";
import { getRun, readHistory } from "./run-store";
import { getUpdateLogPath } from "./build-updater";
import { AppConfig, HistoryEntryWithStaleness } from "./types";
import { getRevision } from "./revision";
import { PeerManager } from "./peer-manager";

export function createRoutes(config: AppConfig, peerManager?: PeerManager): Router {
const router = Router();

router.get("/api/runs/:id/log", (req: Request, res: Response) => {
  const runId = req.params.id;

  // Serve from local cache (works for both local and peer runs)
  const run = getRun(runId);
  if (run?.log_path && fs.existsSync(run.log_path)) {
    const asText = req.query.format === "text";
    res.setHeader("Content-Type", asText ? "text/plain; charset=utf-8" : "application/x-ndjson");
    const stream = fs.createReadStream(run.log_path);
    stream.pipe(res);
    return;
  }

  // Proxy to peer if not cached locally
  if (peerManager) {
    const parsed = peerManager.parsePeerRunId(runId);
    if (parsed) {
      const query = req.query.format === "text" ? "?format=text" : "";
      peerManager.proxyGet(parsed.peerAddress, `/api/runs/${parsed.originalId}/log${query}`, res);
      return;
    }
  }

  res.status(404).json({ error: "Log not available" });
});

router.get("/api/runs/:id/profile", (req: Request, res: Response) => {
  const runId = req.params.id;

  // Serve from local cache (works for both local and peer runs)
  const run = getRun(runId);
  if (run?.profile_path && fs.existsSync(run.profile_path)) {
    res.setHeader("Content-Type", "application/json");
    const stream = fs.createReadStream(run.profile_path);
    stream.pipe(res);
    return;
  }

  // Proxy to peer if not cached locally
  if (peerManager) {
    const parsed = peerManager.parsePeerRunId(runId);
    if (parsed) {
      peerManager.proxyGet(parsed.peerAddress, `/api/runs/${parsed.originalId}/profile`, res);
      return;
    }
  }

  res.status(404).json({ error: "Profile not available" });
});

router.get("/api/history", (_req: Request, res: Response) => {
  // Resolve current revision for each local config
  const currentRevisions = new Map<string, string>();
  for (const c of config.configs) {
    currentRevisions.set(c.name, getRevision(c.mozilla_src));
  }

  // Add peer revisions
  if (peerManager) {
    for (const [name, rev] of peerManager.getPeerRevisions()) {
      currentRevisions.set(name, rev);
    }
  }

  const history = readHistory();
  const runs: HistoryEntryWithStaleness[] = history.map((entry) => ({
    ...entry,
    stale: entry.revision !== currentRevisions.get(entry.config),
  }));

  res.json({ runs });
});

router.get("/api/updates/:id/profile", (req: Request, res: Response) => {
  const updateId = req.params.id;

  if (peerManager) {
    const parsed = peerManager.parsePeerRunId(updateId);
    if (parsed) {
      peerManager.proxyGet(parsed.peerAddress, `/api/updates/${parsed.originalId}/profile`, res);
      return;
    }
  }

  const sourceTree = req.query.source_tree as string | undefined;
  const history = readHistory();
  const matches = history.filter((h) => h.run_id === updateId && h.kind === "update" && h.profile_path);
  const entry = sourceTree
    ? matches.find((h) => h.profile_path!.includes(sourceTree))
    : matches[0];
  const profilePath = entry?.profile_path;

  if (!profilePath || !fs.existsSync(profilePath)) {
    res.status(404).json({ error: "Build profile not available" });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  const stream = fs.createReadStream(profilePath);
  stream.pipe(res);
});

router.get("/api/updates/:id/log", (req: Request, res: Response) => {
  const updateId = req.params.id;

  // Check if this is a peer update (prefixed with peerAddress~)
  if (peerManager) {
    const parsed = peerManager.parsePeerRunId(updateId);
    if (parsed) {
      peerManager.proxyGet(parsed.peerAddress, `/api/updates/${parsed.originalId}/log`, res);
      return;
    }
  }

  const logPath = getUpdateLogPath(updateId);
  if (!logPath) {
    res.status(404).json({ error: "Update log not found" });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const stream = fs.createReadStream(logPath);
  stream.pipe(res);
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23222'/%3E%3Cpath d='M9 17l5 5 9-12' fill='none' stroke='%2340c057' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
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
  .config-list { list-style: none; padding: 0; margin: 0 0 8px 0; }
  .config-list li { padding: 5px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid #eee; }
  .config-name { font-weight: 600; color: #1565c0; }
  .config-path { color: #888; font-size: 0.8rem; font-family: monospace; }
  .config-meta { color: #666; font-size: 0.8rem; }
  .config-update-btn { padding: 1px 6px; font-size: 0.75rem; border: 1px solid #90caf9; background: #fff; color: #1565c0; border-radius: 2px; cursor: pointer; }
  .config-update-btn:hover { background: #bbdefb; }
  .config-update-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .config-status { font-size: 0.8rem; color: #666; }
  .config-status .elapsed { color: #1565c0; }
  .config-status .done { color: #2e7d32; }
  .config-status .failed { color: #c62828; }
  .config-status a { color: #1565c0; cursor: pointer; text-decoration: underline; font-size: 0.8rem; margin-left: 4px; }
  .update-bar { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .update-bar button { padding: 4px 12px; font-size: 0.85rem; border: 1px solid #90caf9; background: #e3f2fd; color: #1565c0; border-radius: 3px; cursor: pointer; }
  .update-bar button:hover { background: #bbdefb; }
  .update-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .config-log { flex-basis: 100%; background: #1e1e1e; color: #d4d4d4; font-family: monospace; font-size: 0.75rem; border-radius: 6px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; display: none; margin: 4px 0; }
  .config-log.visible { display: block; padding: 10px; }
  .config-log .log-status { color: #569cd6; }
  .config-log .log-stderr { color: #f48771; }
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
<div class="update-bar">
  <button id="update-all-btn" onclick="requestUpdate()" disabled>Update All</button>
</div>

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
let wsRef = null;
let currentConfigs = [];

// Per-config update tracking: configName -> { updateId, startTime, timerInterval }
const activeUpdates = new Map();
// Per-config finished update info: configName -> { updateId, success, error, elapsed, hasProfile, sourceTree }
const finishedUpdates = new Map();

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
}

function matchUpdateId(stored, received) {
  return stored === received || received.endsWith('~' + stored);
}

function isConfigUpdating(name) {
  return activeUpdates.has(name);
}

function isAnyUpdateRunning() {
  return activeUpdates.size > 0;
}

function requestUpdate(configNames) {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) return;
  const targets = configNames || currentConfigs.map(c => c.name);
  if (targets.some(n => isConfigUpdating(n))) return;

  // Send a separate update request per config so each gets its own ID
  targets.forEach(name => {
    const updateId = Math.random().toString(36).slice(2, 10);
    const msg = { type: 'update_builds', update_id: updateId, configs: [name] };
    wsRef.send(JSON.stringify(msg));

    finishedUpdates.delete(name);
    const logEl = document.querySelector('.config-log[data-config="' + name + '"]');
    if (logEl) { logEl.innerHTML = ''; logEl.classList.remove('visible'); }
    activeUpdates.set(name, { updateId, startTime: null, timerInterval: null, started: false });
    activeRuns.set(updateId, { status: 'queued', test: 'mach build', config: name });
    const el = document.querySelector('.config-status[data-config="' + name + '"]');
    if (el) el.innerHTML = '<span class="elapsed">queued</span>';
  });
  renderActive();
  refreshButtons();
}

function tickTimer(configName) {
  const info = activeUpdates.get(configName);
  if (!info || !info.started) return;
  const el = document.querySelector('.config-status[data-config="' + configName + '"]');
  if (!el) return;
  const elapsed = formatElapsed(Date.now() - info.startTime);
  const logEl = document.querySelector('.config-log[data-config="' + configName + '"]');
  const logVisible = logEl && logEl.classList.contains('visible');
  el.innerHTML = '<span class="elapsed">updating ' + elapsed + '</span>' +
    ' <a class="toggle-log" href="javascript:void(0)" title="Alt+click: open raw log in new tab">' + (logVisible ? 'hide log' : 'log') + '</a>';
  el.querySelector('.toggle-log').addEventListener('click', function(ev) {
    ev.preventDefault();
    if (ev.altKey) {
      window.open('/api/updates/' + info.updateId + '/log', '_blank');
    } else {
      toggleConfigLog(configName);
    }
  });
}

function refreshButtons() {
  document.querySelectorAll('.config-update-btn').forEach(btn => {
    btn.disabled = isConfigUpdating(btn.dataset.config);
  });
  // Disable "Update All" if any config is already updating
  document.getElementById('update-all-btn').disabled = isAnyUpdateRunning();
}

function toggleConfigLog(configName) {
  const logEl = document.querySelector('.config-log[data-config="' + configName + '"]');
  if (!logEl) return;
  const isVisible = logEl.classList.contains('visible');
  logEl.classList.toggle('visible');
  const statusEl = document.querySelector('.config-status[data-config="' + configName + '"]');
  if (statusEl) {
    const link = statusEl.querySelector('.toggle-log');
    if (link) link.textContent = isVisible ? 'log' : 'hide log';
  }
  // For finished updates, load log from server on first open
  if (!isVisible) {
    const info = finishedUpdates.get(configName);
    if (info && !logEl.dataset.loaded) {
      logEl.textContent = 'Loading...';
      fetch('/api/updates/' + info.updateId + '/log')
        .then(r => r.text())
        .then(text => {
          logEl.innerHTML = '';
          var NL = String.fromCharCode(10);
          text.split(NL).forEach(function(line) {
            if (!line) return;
            var span = document.createElement('span');
            if (line.indexOf('[status]') !== -1) span.className = 'log-status';
            else if (line.indexOf('[stderr]') !== -1) span.className = 'log-stderr';
            span.textContent = line + NL;
            logEl.appendChild(span);
          });
          logEl.dataset.loaded = '1';
          logEl.scrollTop = logEl.scrollHeight;
        })
        .catch(() => { logEl.textContent = 'Failed to load log'; });
    } else {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

function openBuildProfile(updateId, sourceTree) {
  var profileUrl = location.origin + '/api/updates/' + updateId + '/profile';
  if (sourceTree) profileUrl += '?source_tree=' + encodeURIComponent(sourceTree);
  const profileName = 'mach build (' + updateId + ')';
  const profilerUrl = 'https://profiler.firefox.com/from-url/' +
    encodeURIComponent(profileUrl) +
    '/?profileName=' + encodeURIComponent(profileName);
  window.open(profilerUrl, '_blank');
}

function renderFinishedStatus(el, info, configName) {
  const logEl = document.querySelector('.config-log[data-config="' + configName + '"]');
  const logVisible = logEl && logEl.classList.contains('visible');
  const parts = [];
  if (info.success) {
    parts.push('<span class="done">updated in ' + info.elapsed + '</span>');
  } else {
    parts.push('<span class="failed">failed: ' + (info.error || 'unknown') + '</span>');
  }
  parts.push('<a class="toggle-log" href="javascript:void(0)" title="Alt+click: open raw log in new tab">' + (logVisible ? 'hide log' : 'log') + '</a>');
  if (info.hasProfile) {
    parts.push('<a href="javascript:void(0)" class="profile-link">profile</a>');
  }
  el.innerHTML = parts.join(' ');
  el.querySelector('.toggle-log').addEventListener('click', function(e) {
    e.preventDefault();
    if (e.altKey) {
      window.open('/api/updates/' + info.updateId + '/log', '_blank');
    } else {
      toggleConfigLog(configName);
    }
  });
  const profLink = el.querySelector('.profile-link');
  if (profLink) profLink.addEventListener('click', () => openBuildProfile(info.updateId, info.sourceTree));
}

function finishUpdate(msg) {
  const updateId = msg.update_id;

  // Find which configs belong to this update
  const finishedConfigs = [];
  for (const [name, info] of activeUpdates) {
    if (matchUpdateId(info.updateId, updateId)) {
      if (info.timerInterval) clearInterval(info.timerInterval);
      const elapsed = info.startTime ? formatElapsed(Date.now() - info.startTime) : '0s';
      // Each update targets one config, so use the first result
      const result = msg.results && msg.results[0];
      const success = result ? result.success : msg.success;
      const error = result && !result.success ? result.error : null;
      const hasProfile = result && !!result.profile_path;
      const sourceTree = result ? result.source_tree : null;
      finishedUpdates.set(name, { updateId, success, error, elapsed, hasProfile, sourceTree });
      finishedConfigs.push(name);
    }
  }
  finishedConfigs.forEach(n => activeUpdates.delete(n));
  activeRuns.delete(updateId);
  renderActive();
  refreshButtons();

  // Update status on finished configs
  finishedConfigs.forEach(name => {
    const el = document.querySelector('.config-status[data-config="' + name + '"]');
    if (!el) return;
    renderFinishedStatus(el, finishedUpdates.get(name), name);
  });
}

function renderConfigs(configs) {
  currentConfigs = configs;
  const el = document.getElementById('configs');

  // Try in-place update: match existing items by config name
  var updated = false;
  if (el.querySelector('.config-list')) {
    var existing = {};
    el.querySelectorAll('.config-list li').forEach(function(li) {
      var nameEl = li.querySelector('.config-name');
      if (nameEl) existing[nameEl.textContent] = li;
    });
    if (configs.length === Object.keys(existing).length && configs.every(function(c) { return existing[c.name]; })) {
      configs.forEach(function(c) {
        var rev = c.revision ? c.revision.slice(0, 12) : '?';
        var branch = c.branch || '?';
        var li = existing[c.name];
        var metaEl = li.querySelector('.config-meta');
        if (metaEl) metaEl.textContent = branch + ' @ ' + rev;
        var pathEl = li.querySelector('.config-path');
        if (pathEl) pathEl.textContent = c.mozilla_src || '';
      });
      updated = true;
    }
  }
  if (updated) return;

  // Full rebuild needed (first render or configs added/removed)
  el.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'config-list';
  configs.forEach(c => {
    const rev = c.revision ? c.revision.slice(0, 12) : '?';
    const branch = c.branch || '?';
    const li = document.createElement('li');

    const nameEl = document.createElement('span');
    nameEl.className = 'config-name';
    nameEl.textContent = c.name;

    const pathEl = document.createElement('span');
    pathEl.className = 'config-path';
    pathEl.textContent = c.mozilla_src || '';

    const metaEl = document.createElement('span');
    metaEl.className = 'config-meta';
    metaEl.dataset.config = c.name;
    metaEl.textContent = branch + ' @ ' + rev;

    const btn = document.createElement('button');
    btn.className = 'config-update-btn';
    btn.textContent = 'Update';
    btn.dataset.config = c.name;
    btn.disabled = isConfigUpdating(c.name);
    btn.addEventListener('click', () => requestUpdate([c.name]));

    const statusEl = document.createElement('span');
    statusEl.className = 'config-status';
    statusEl.dataset.config = c.name;

    const logDiv = document.createElement('div');
    logDiv.className = 'config-log';
    logDiv.dataset.config = c.name;

    li.appendChild(nameEl);
    li.appendChild(pathEl);
    li.appendChild(metaEl);
    li.appendChild(btn);
    li.appendChild(statusEl);
    li.appendChild(logDiv);
    ul.appendChild(li);
  });
  el.appendChild(ul);

  // Restore state for in-progress and finished updates
  for (const [name] of activeUpdates) tickTimer(name);
  for (const [name, info] of finishedUpdates) {
    const statusEl = document.querySelector('.config-status[data-config="' + name + '"]');
    if (statusEl) renderFinishedStatus(statusEl, info, name);
  }
}

function appendUpdateLog(sourceTree, stream, text) {
  // Find all config log divs whose mozilla_src matches this source_tree
  const matchingConfigs = currentConfigs.filter(c => c.mozilla_src === sourceTree);
  const configNames = matchingConfigs.map(c => c.name);
  // If no match (e.g. peer), try all configs that are currently updating
  if (configNames.length === 0) {
    for (const [name] of activeUpdates) configNames.push(name);
  }

  configNames.forEach(name => {
    const logEl = document.querySelector('.config-log[data-config="' + name + '"]');
    if (!logEl) return;
    const span = document.createElement('span');
    if (stream === 'status') span.className = 'log-status';
    else if (stream === 'stderr') span.className = 'log-stderr';
    span.textContent = text + String.fromCharCode(10);
    logEl.appendChild(span);
    if (logEl.classList.contains('visible')) logEl.scrollTop = logEl.scrollHeight;
  });
}

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
  wsRef = ws;
  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');

  ws.onopen = () => {
    dot.className = 'ws-dot connected';
    label.textContent = 'Connected';
    refreshButtons();
  };

  ws.onclose = () => {
    dot.className = 'ws-dot disconnected';
    label.textContent = 'Disconnected — reconnecting...';
    document.getElementById('update-all-btn').disabled = true;
    document.querySelectorAll('.config-update-btn').forEach(b => b.disabled = true);
    setTimeout(connectWs, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'configs') {
      renderConfigs(msg.configs);
    }

    if (msg.type === 'update_started') {
      const startTime = Date.now();
      for (const [name, info] of activeUpdates) {
        if (matchUpdateId(info.updateId, msg.update_id) && !info.started) {
          var oldId = info.updateId;
          info.updateId = msg.update_id; // adopt prefixed ID for log/profile URLs
          info.started = true;
          info.startTime = startTime;
          info.timerInterval = setInterval(() => tickTimer(name), 1000);
          tickTimer(name);
          activeRuns.delete(oldId);
          activeRuns.set(msg.update_id, { status: 'running', test: 'mach build', config: name });
        }
      }
      renderActive();
    }

    if (msg.type === 'update_output') {
      appendUpdateLog(msg.source_tree, msg.stream, msg.text);
    }

    if (msg.type === 'update_completed') {
      // Collect config names before finishUpdate clears activeUpdates
      var completedConfigs = [];
      for (var [cn, ci] of activeUpdates) {
        if (matchUpdateId(ci.updateId, msg.update_id)) completedConfigs.push(cn);
      }
      finishUpdate(msg);

      // Add to history table
      var result = msg.results && msg.results[0];
      completedConfigs.forEach(function(name) {
        addHistoryRow({
          run_id: msg.update_id,
          test: 'mach build',
          config: name,
          status: result ? (result.success ? 'PASS' : 'FAIL') : (msg.success ? 'PASS' : 'FAIL'),
          reproduced: false,
          duration_seconds: result ? (result.duration_seconds || 0) : 0,
          finished_at: result ? (result.finished_at || new Date().toISOString()) : new Date().toISOString(),
          stale: false,
          kind: 'update',
        });
      });
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

function openProfiler(runId, test, config, kind) {
  const base = kind === 'update' ? '/api/updates/' : '/api/runs/';
  const profileUrl = location.origin + base + runId + '/profile';
  const cmd = kind === 'update' ? 'mach build' : 'mach test ' + (test.split('/').pop() || test);
  const profileName = cmd + ' (' + config + ')';
  const profilerUrl = 'https://profiler.firefox.com/from-url/' +
    encodeURIComponent(profileUrl) +
    '/?profileName=' + encodeURIComponent(profileName);
  window.open(profilerUrl, '_blank');
}

function makeRowClickable(tr, runId, test, config, kind) {
  tr.classList.add('clickable');
  tr.title = 'Click: Firefox Profiler | Alt+Click: raw log';
  const base = kind === 'update' ? '/api/updates/' : '/api/runs/';
  tr.addEventListener('click', (e) => {
    if (e.altKey) {
      window.open(base + runId + '/log?format=text', '_blank');
    } else {
      openProfiler(runId, test, config, kind);
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
  makeRowClickable(tr, r.run_id, r.test, r.config, r.kind || 'test');
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
        makeRowClickable(tr, r.run_id, r.test, r.config, r.kind || 'test');
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
