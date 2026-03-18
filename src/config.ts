import * as fs from "fs";
import * as path from "path";
import { AppConfig } from "./types";
import { logError } from "./log";

const CONFIG_PATH = path.join(
  process.env.HOME || "~",
  ".test-runner",
  "config.json"
);

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config: AppConfig = JSON.parse(raw);

  if (!config.port || typeof config.port !== "number") {
    throw new Error("Config must specify a numeric 'port'");
  }

  if (!Array.isArray(config.configs) || config.configs.length === 0) {
    throw new Error("Config must specify at least one build config");
  }

  for (const c of config.configs) {
    if (!c.name || !c.mozilla_src || !c.obj_dir) {
      throw new Error(
        `Each config must have name, mozilla_src, and obj_dir. Got: ${JSON.stringify(c)}`
      );
    }
    if (!fs.existsSync(c.mozilla_src)) {
      logError(`Warning: mozilla_src does not exist: ${c.mozilla_src}`);
    }
  }

  return config;
}
