import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import { AppConfig } from "./types";
import { createRoutes } from "./routes";
import { handleWsConnection, setWss, setPeerManager, broadcast } from "./ws-handler";
import { PeerManager } from "./peer-manager";
import { log } from "./log";

export function createServer(config: AppConfig): { server: http.Server; peerManager: PeerManager | null } {
  const app = express();

  // Create peer manager if peers are configured
  let peerManager: PeerManager | null = null;
  if (config.peers && config.peers.length > 0) {
    peerManager = new PeerManager(config, broadcast);
    setPeerManager(peerManager);
  }

  app.use(cors());
  app.use(express.json());
  app.use(createRoutes(config, peerManager || undefined));

  const server = http.createServer(app);

  const wss = new WebSocketServer({ server });
  setWss(wss);
  wss.on("connection", (ws) => {
    log("WebSocket client connected");
    handleWsConnection(ws, config);

    ws.on("close", () => {
      log("WebSocket client disconnected");
    });
  });

  return { server, peerManager };
}
