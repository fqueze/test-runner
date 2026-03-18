import { loadConfig } from "./config";
import { createServer } from "./server";
import { log, logError } from "./log";
import { killAllChildren } from "./test-runner";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err: any) {
    logError("Failed to load config:", err.message);
    process.exit(1);
  }

  log(
    `Loaded ${config.configs.length} config(s): ${config.configs.map((c) => c.name).join(", ")}`
  );
  if (config.peers && config.peers.length > 0) {
    log(`Configured ${config.peers.length} peer(s): ${config.peers.map((p) => p.address).join(", ")}`);
  }

  const { server, peerManager } = createServer(config);
  server.listen(config.port, () => {
    log(`Test runner listening on port ${config.port}`);
    log(`WebSocket: ws://localhost:${config.port}`);
    log(`REST API:  http://localhost:${config.port}/api`);

    // Connect to peers after server is listening
    if (peerManager) {
      peerManager.connectAll();
    }
  });

  const shutdown = () => {
    log("Shutting down, killing active test processes...");
    killAllChildren();
    if (peerManager) {
      peerManager.disconnectAll();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
