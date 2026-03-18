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

  const server = createServer(config);
  server.listen(config.port, () => {
    log(`Test runner listening on port ${config.port}`);
    log(`WebSocket: ws://localhost:${config.port}`);
    log(`REST API:  http://localhost:${config.port}/api`);
  });

  const shutdown = () => {
    log("Shutting down, killing active test processes...");
    killAllChildren();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
