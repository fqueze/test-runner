import WebSocket, { WebSocketServer } from "ws";
import { AppConfig, WsClientMessage, WsServerMessage, Run } from "./types";
import { executeTestRun, RunCallbacks } from "./test-runner";
import { generateRunId, createRun } from "./run-store";
import { getRevision } from "./revision";
import { log, logError } from "./log";
import { PeerManager } from "./peer-manager";

// Global run queue: mach test binds to fixed ports (8888, etc.) so only one run at a time.
let runQueue: Promise<void> = Promise.resolve();

function enqueueRun(fn: () => Promise<void>): void {
  runQueue = runQueue.then(fn, fn); // run even if previous failed
}

let wssInstance: WebSocketServer | null = null;
let peerManagerInstance: PeerManager | null = null;

export function setWss(wss: WebSocketServer): void {
  wssInstance = wss;
}

export function setPeerManager(pm: PeerManager): void {
  peerManagerInstance = pm;

  // When peer configs change, broadcast updated config list to all dashboard clients
  pm.onConfigsChanged(() => {
    broadcastConfigsToAll();
  });
}

export function broadcast(msg: WsServerMessage): void {
  if (!wssInstance) return;
  const data = JSON.stringify(msg);
  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function getAggregatedConfigs(config: AppConfig): { name: string; revision?: string }[] {
  const localConfigs = config.configs.map((c) => ({
    name: c.name,
    revision: getRevision(c.mozilla_src),
  }));

  if (!peerManagerInstance) return localConfigs;

  const peerConfigs = peerManagerInstance.getAggregatedConfigs();
  return [...localConfigs, ...peerConfigs];
}

// Cache the AppConfig so we can rebuild aggregated configs on peer changes
let appConfigRef: AppConfig | null = null;

function broadcastConfigsToAll(): void {
  if (!appConfigRef) return;
  const configs = getAggregatedConfigs(appConfigRef);
  broadcast({ type: "configs", configs });
}

export function handleWsConnection(ws: WebSocket, config: AppConfig): void {
  appConfigRef = config;

  // Send available configs on connection (local + peer)
  const configsMsg: WsServerMessage = {
    type: "configs",
    configs: getAggregatedConfigs(config),
  };
  ws.send(JSON.stringify(configsMsg));

  ws.on("message", (data) => {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "run_error", run_id: "", request_id: "", error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "run") {
      log(`WS request: run ${msg.test} on ${msg.config} (request_id: ${msg.request_id})`);
      handleRunRequest(config, msg);
    } else {
      log(`WS unknown message type: ${(msg as any).type}`);
    }
  });
}

function handleRunRequest(
  appConfig: AppConfig,
  msg: WsClientMessage & { type: "run" }
): void {
  const buildConfig = appConfig.configs.find((c) => c.name === msg.config);

  // If config is not local, try forwarding to a peer
  if (!buildConfig) {
    if (peerManagerInstance && peerManagerInstance.forwardRunToPeer(msg.config, msg)) {
      log(`Forwarded run to peer for config "${msg.config}"`);
      return;
    }

    log(`WS rejected run: unknown config "${msg.config}"`);
    broadcast({
      type: "run_error",
      run_id: "",
      request_id: msg.request_id,
      error: `Unknown config: ${msg.config}`,
    });
    return;
  }

  // Create the run and notify immediately, before enqueuing
  const runId = generateRunId();
  const run = createRun(runId, msg.request_id, msg.test, msg.config, msg.extra_args || []);
  log(`[${runId}] Queued: ${msg.test} on ${msg.config}`);
  broadcast({
    type: "run_queued",
    request_id: run.request_id,
    run_id: run.run_id,
    test: run.test,
    config: run.config,
  });

  const callbacks: RunCallbacks = {
    onStarted(run: Run) {
      broadcast({
        type: "run_started",
        run_id: run.run_id,
        test: run.test,
        config: run.config,
      });
    },
    onCompleted(run: Run) {
      broadcast({
        type: "run_completed",
        run_id: run.run_id,
        request_id: run.request_id,
        config: run.config,
        test: run.test,
        status: run.status!,
        reproduced: run.reproduced,
        duration_seconds: run.duration_seconds!,
        exit_code: run.exit_code!,
        summary: run.summary!,
        created_at: run.created_at,
        started_at: run.started_at || undefined,
        finished_at: run.finished_at || undefined,
        revision: run.revision || undefined,
      });
    },
    onError(run: Run, error: string) {
      broadcast({
        type: "run_error",
        run_id: run.run_id,
        request_id: run.request_id,
        error,
      });
    },
  };

  // Global queue: mach test uses fixed ports, so runs must be sequential
  enqueueRun(() =>
    executeTestRun(
      run,
      buildConfig,
      callbacks
    ).catch((err) => {
      logError("Unhandled error in executeTestRun:", err);
    })
  );
}
