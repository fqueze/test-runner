import WebSocket, { WebSocketServer } from "ws";
import { AppConfig, WsClientMessage, WsServerMessage, WsUpdateRequest, UpdateResult, Run } from "./types";
import { executeTestRun, RunCallbacks } from "./test-runner";
import { executeUpdate, UpdateCallbacks } from "./build-updater";
import { generateRunId, createRun, appendHistoryEntry } from "./run-store";
import { getRevision, getBranch } from "./revision";
import { log, logError } from "./log";
import { PeerManager } from "./peer-manager";

// Per-source-tree run queues: runs on different source trees execute in parallel,
// while runs sharing the same source tree remain sequential.
const runQueues = new Map<string, Promise<void>>();

function enqueueRun(sourceTree: string, fn: () => Promise<void>): void {
  const current = runQueues.get(sourceTree) || Promise.resolve();
  runQueues.set(sourceTree, current.then(fn, fn)); // run even if previous failed
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

function getAggregatedConfigs(config: AppConfig): { name: string; revision?: string; branch?: string; local?: boolean }[] {
  const localConfigs = config.configs.map((c) => ({
    name: c.name,
    revision: getRevision(c.mozilla_src),
    branch: getBranch(c.mozilla_src),
    mozilla_src: c.mozilla_src,
    local: true,
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
    } else if (msg.type === "update_builds") {
      log(`WS request: update_builds (update_id: ${msg.update_id}, configs: ${msg.configs ? msg.configs.join(", ") : "all"})`);
      handleUpdateRequest(config, msg);
    } else {
      log(`WS unknown message type: ${(msg as any).type}`);
    }
  });
}

function handleUpdateRequest(
  appConfig: AppConfig,
  msg: WsUpdateRequest
): void {
  const revision = msg.revision || "origin/main";

  // Filter configs if specific ones requested
  const targetConfigs = msg.configs
    ? appConfig.configs.filter((c) => msg.configs!.includes(c.name))
    : appConfig.configs;

  // Forward to peers
  if (peerManagerInstance) {
    peerManagerInstance.forwardUpdateToPeers(msg);
  }

  // Nothing to do locally or remotely
  if (targetConfigs.length === 0 && !peerManagerInstance) {
    broadcast({
      type: "update_completed",
      update_id: msg.update_id,
      success: true,
      results: [],
    });
    return;
  }

  // No local configs to update — peer will handle it
  if (targetConfigs.length === 0) {
    return;
  }

  // Broadcast started immediately
  broadcast({ type: "update_started", update_id: msg.update_id });

  // Group configs by source tree and enqueue each tree independently
  const treeConfigs = new Map<string, typeof targetConfigs>();
  for (const c of targetConfigs) {
    const existing = treeConfigs.get(c.mozilla_src);
    if (existing) existing.push(c);
    else treeConfigs.set(c.mozilla_src, [c]);
  }

  const resultPromises: Promise<UpdateResult[]>[] = [];

  for (const [tree, cfgs] of treeConfigs) {
    const resultPromise = new Promise<UpdateResult[]>((resolveResults) => {
      enqueueRun(tree, () =>
        executeUpdate(cfgs, revision, msg.update_id, {
          onStarted() {
            // Already broadcast above
          },
          onOutput(sourceTree, stream, text) {
            broadcast({
              type: "update_output",
              update_id: msg.update_id,
              source_tree: sourceTree,
              stream,
              text,
            });
          },
          onCompleted(results) {
            resolveResults(results);
          },
        }).catch((err) => {
          logError("Unhandled error in executeUpdate:", err);
          resolveResults([]);
        })
      );
    });
    resultPromises.push(resultPromise);
  }

  // When all trees complete, record history and broadcast final result
  Promise.all(resultPromises).then((resultArrays) => {
    const allResults = resultArrays.flat();

    // Record each updated tree in history, mapped to its config names
    for (const result of allResults) {
      const configsForTree = targetConfigs.filter((c) => c.mozilla_src === result.source_tree);
      for (const cfg of configsForTree) {
        appendHistoryEntry({
          run_id: msg.update_id,
          test: "mach build",
          config: cfg.name,
          status: result.success ? "PASS" : "FAIL",
          reproduced: false,
          exit_code: result.success ? 0 : 1,
          created_at: result.started_at || new Date().toISOString(),
          started_at: result.started_at || new Date().toISOString(),
          finished_at: result.finished_at || new Date().toISOString(),
          duration_seconds: result.duration_seconds || 0,
          revision: result.new_revision || getRevision(cfg.mozilla_src),
          kind: "update",
          profile_path: result.profile_path,
        });
      }
    }

    broadcast({
      type: "update_completed",
      update_id: msg.update_id,
      success: allResults.every((r) => r.success),
      results: allResults,
    });
    // Refresh configs with new revisions/branches
    broadcastConfigsToAll();
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

  enqueueRun(buildConfig.mozilla_src, () =>
    executeTestRun(
      run,
      buildConfig,
      callbacks
    ).catch((err) => {
      logError("Unhandled error in executeTestRun:", err);
    })
  );
}
