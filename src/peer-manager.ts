import WebSocket from "ws";
import * as http from "http";
import { AppConfig, WsServerMessage, WsRunRequest, HistoryEntry, RunStatus } from "./types";
import { appendHistoryEntry } from "./run-store";
import { log, logError } from "./log";

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

interface PeerConfigEntry {
  name: string;
  revision?: string;
}

type BroadcastFn = (msg: WsServerMessage) => void;

class PeerConnection {
  readonly address: string;
  private ws: WebSocket | null = null;
  private configs: PeerConfigEntry[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private alive = false;
  private broadcast: BroadcastFn;
  private manager: PeerManager;
  connected = false;

  constructor(address: string, broadcast: BroadcastFn, manager: PeerManager) {
    this.address = address;
    this.broadcast = broadcast;
    this.manager = manager;
  }

  connect(): void {
    if (this.ws) return;

    const url = `ws://${this.address}`;
    log(`Connecting to peer ${this.address}...`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      log(`Connected to peer ${this.address}`);
      this.connected = true;
      this.alive = true;
      this.startPing();
    });

    ws.on("message", (data) => {
      this.handleMessage(data.toString());
    });

    ws.on("close", () => {
      log(`Peer ${this.address} disconnected`);
      this.cleanup();
      this.scheduleReconnect();
      this.manager.broadcastAggregatedConfigs();
    });

    ws.on("error", (err) => {
      logError(`Peer ${this.address} error: ${err.message}`);
    });

    ws.on("pong", () => {
      this.alive = true;
    });
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "configs") {
      this.configs = msg.configs || [];
      log(`Peer ${this.address} offers configs: ${this.configs.map((c: PeerConfigEntry) => c.name).join(", ")}`);
      this.manager.broadcastAggregatedConfigs();
      return;
    }

    // Relay run lifecycle messages with prefixed run_id
    if (msg.run_id && ["run_queued", "run_started", "run_completed", "run_error"].includes(msg.type)) {
      msg.run_id = `${this.address}~${msg.run_id}`;
      this.broadcast(msg);

      // Record completed runs in local history
      if (msg.type === "run_completed") {
        this.recordCompletion(msg);
      }
    }
  }

  private recordCompletion(msg: any): void {
    const now = new Date().toISOString();
    const entry: HistoryEntry = {
      run_id: msg.run_id,
      test: msg.test || "",
      config: msg.config || "",
      status: (msg.status || "ERROR") as RunStatus,
      reproduced: msg.reproduced || false,
      exit_code: msg.exit_code ?? -1,
      created_at: msg.created_at || now,
      started_at: msg.started_at || now,
      finished_at: msg.finished_at || now,
      duration_seconds: msg.duration_seconds || 0,
      revision: msg.revision || this.getRevision(msg.config) || "unknown",
    };
    appendHistoryEntry(entry);
  }

  forwardRun(msg: WsRunRequest): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  getConfigs(): PeerConfigEntry[] {
    return this.connected ? this.configs : [];
  }

  getRevision(configName: string): string | undefined {
    return this.configs.find((c) => c.name === configName)?.revision;
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (!this.alive) {
        log(`Peer ${this.address} ping timeout, disconnecting`);
        this.ws?.terminate();
        return;
      }
      this.alive = false;
      this.ws?.ping();
    }, PING_INTERVAL_MS);
  }

  private cleanup(): void {
    this.connected = false;
    this.configs = [];
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.configs = [];
  }
}

export class PeerManager {
  private peers: PeerConnection[] = [];
  private appConfig: AppConfig;

  constructor(appConfig: AppConfig, broadcast: BroadcastFn) {
    this.appConfig = appConfig;

    for (const peer of appConfig.peers || []) {
      this.peers.push(new PeerConnection(peer.address, broadcast, this));
    }
  }

  connectAll(): void {
    for (const peer of this.peers) {
      peer.connect();
    }
  }

  disconnectAll(): void {
    for (const peer of this.peers) {
      peer.disconnect();
    }
  }

  getAggregatedConfigs(): { name: string; revision?: string }[] {
    const configs: { name: string; revision?: string }[] = [];
    for (const peer of this.peers) {
      for (const c of peer.getConfigs()) {
        configs.push({ name: c.name, revision: c.revision });
      }
    }
    return configs;
  }

  broadcastAggregatedConfigs(): void {
    // This is called when peer configs change.
    // The ws-handler will pick up the new configs on the next connection.
    // For existing connections, we need to broadcast the update.
    // Import is circular, so we use the broadcast function passed to PeerConnection.
    // The broadcast already happens via the PeerConnection's handleMessage for configs.
    // We need a way to push updated configs to all dashboard clients.
    // This is handled by re-broadcasting from ws-handler.
    if (this._onConfigsChanged) {
      this._onConfigsChanged();
    }
  }

  private _onConfigsChanged: (() => void) | null = null;

  onConfigsChanged(fn: () => void): void {
    this._onConfigsChanged = fn;
  }

  getPeerForConfig(configName: string): PeerConnection | null {
    for (const peer of this.peers) {
      if (peer.getConfigs().some((c) => c.name === configName)) {
        return peer;
      }
    }
    return null;
  }

  forwardRunToPeer(configName: string, msg: WsRunRequest): boolean {
    const peer = this.getPeerForConfig(configName);
    if (!peer) return false;
    peer.forwardRun(msg);
    return true;
  }

  parsePeerRunId(runId: string): { peerAddress: string; originalId: string } | null {
    const idx = runId.indexOf("~");
    if (idx === -1) return null;
    return {
      peerAddress: runId.slice(0, idx),
      originalId: runId.slice(idx + 1),
    };
  }

  proxyGet(peerAddress: string, urlPath: string, res: http.ServerResponse): void {
    const url = `http://${peerAddress}${urlPath}`;
    log(`Proxying to peer: ${url}`);

    http.get(url, (peerRes) => {
      res.writeHead(peerRes.statusCode || 502, peerRes.headers);
      peerRes.pipe(res);
    }).on("error", (err) => {
      logError(`Proxy error for ${peerAddress}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: `Peer unreachable: ${err.message}` }));
      }
    });
  }

  getPeerRevisions(): Map<string, string> {
    const revisions = new Map<string, string>();
    for (const peer of this.peers) {
      for (const c of peer.getConfigs()) {
        if (c.revision) {
          revisions.set(c.name, c.revision);
        }
      }
    }
    return revisions;
  }

  hasPeers(): boolean {
    return this.peers.length > 0;
  }
}
