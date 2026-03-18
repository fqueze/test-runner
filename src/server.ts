import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import { AppConfig } from "./types";
import { createRoutes } from "./routes";
import { handleWsConnection, setWss } from "./ws-handler";
import { log } from "./log";

export function createServer(config: AppConfig): http.Server {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(createRoutes(config));

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

  return server;
}
