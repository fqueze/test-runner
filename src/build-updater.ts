import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { BuildConfig, UpdateResult } from "./types";
import { getRevision } from "./revision";
import { log, logError } from "./log";

const BASE_DIR = path.join(process.env.HOME || "~", ".test-runner");
const UPDATES_DIR = path.join(BASE_DIR, "updates");

const GIT_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 3_600_000; // 1 hour
const BUILD_INACTIVITY_MS = 600_000; // 10 minutes

export interface UpdateCallbacks {
  onStarted(): void;
  onOutput(sourceTree: string, stream: "stdout" | "stderr" | "status", text: string): void;
  onCompleted(results: UpdateResult[]): void;
}

export async function executeUpdate(
  configs: BuildConfig[],
  revision: string,
  updateId: string,
  callbacks: UpdateCallbacks
): Promise<void> {
  // Deduplicate by mozilla_src, collecting all obj_dirs per tree
  const treeConfigs = new Map<string, BuildConfig[]>();
  for (const c of configs) {
    const existing = treeConfigs.get(c.mozilla_src);
    if (existing) {
      existing.push(c);
    } else {
      treeConfigs.set(c.mozilla_src, [c]);
    }
  }

  callbacks.onStarted();

  // Ensure log directory exists
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const logPath = path.join(UPDATES_DIR, `${updateId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const writeLog = (line: string) => {
    logStream.write(line + "\n");
  };

  const emitOutput = (sourceTree: string, stream: "stdout" | "stderr" | "status", text: string) => {
    writeLog(`[${new Date().toISOString()}] [${path.basename(sourceTree)}] [${stream}] ${text}`);
    callbacks.onOutput(sourceTree, stream, text);
  };

  const results: UpdateResult[] = [];

  for (const [tree, cfgs] of treeConfigs) {
    log(`[update:${updateId}] Updating tree: ${tree}`);
    const buildStartTime = Date.now();
    const result = await updateTree(tree, revision, path.basename(tree), emitOutput);

    // Find build profile (served directly from source location)
    if (result.success) {
      const profileSrc = findLatestBuildProfile(cfgs, buildStartTime);
      if (profileSrc) {
        result.profile_path = profileSrc;
        log(`[update:${updateId}] Found build profile: ${profileSrc}`);
      }
    }

    results.push(result);
  }

  logStream.end();
  callbacks.onCompleted(results);
}

async function updateTree(
  mozillaSrc: string,
  revision: string,
  treeName: string,
  emit: (sourceTree: string, stream: "stdout" | "stderr" | "status", text: string) => void
): Promise<UpdateResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: { label: string; cmd: string; args: string[]; timeoutMs: number; inactivityMs?: number }[] = [
    { label: "Fetching", cmd: "git", args: ["fetch", "origin"], timeoutMs: GIT_TIMEOUT_MS },
    { label: "Checking out", cmd: "git", args: ["checkout", revision], timeoutMs: GIT_TIMEOUT_MS },
    {
      label: "Building",
      cmd: path.join(mozillaSrc, "mach"),
      args: ["build"],
      timeoutMs: BUILD_TIMEOUT_MS,
      inactivityMs: BUILD_INACTIVITY_MS,
    },
  ];

  for (const step of steps) {
    emit(mozillaSrc, "status", `${step.label}...`);
    log(`[update] ${treeName}: ${step.label} (${step.cmd} ${step.args.join(" ")})`);

    try {
      const exitCode = await spawnStreaming(
        step.cmd,
        step.args,
        mozillaSrc,
        step.timeoutMs,
        step.inactivityMs,
        (stream, text) => emit(mozillaSrc, stream, text)
      );

      if (exitCode !== 0) {
        const error = `${step.label} failed with exit code ${exitCode}`;
        emit(mozillaSrc, "status", error);
        logError(`[update] ${treeName}: ${error}`);
        const finishedAt = new Date().toISOString();
        const duration = Math.round((Date.now() - startMs) / 1000);
        return { source_tree: mozillaSrc, success: false, error, started_at: startedAt, finished_at: finishedAt, duration_seconds: duration };
      }

      emit(mozillaSrc, "status", `${step.label} completed`);
    } catch (err: any) {
      const error = `${step.label} error: ${err.message}`;
      emit(mozillaSrc, "status", error);
      logError(`[update] ${treeName}: ${error}`);
      const finishedAt = new Date().toISOString();
      const duration = Math.round((Date.now() - startMs) / 1000);
      return { source_tree: mozillaSrc, success: false, error, started_at: startedAt, finished_at: finishedAt, duration_seconds: duration };
    }
  }

  const finishedAt = new Date().toISOString();
  const duration = Math.round((Date.now() - startMs) / 1000);
  const newRevision = getRevision(mozillaSrc);
  emit(mozillaSrc, "status", `Update complete (${newRevision.slice(0, 12)})`);
  log(`[update] ${treeName}: complete at ${newRevision.slice(0, 12)}`);
  return { source_tree: mozillaSrc, success: true, new_revision: newRevision, started_at: startedAt, finished_at: finishedAt, duration_seconds: duration };
}

function spawnStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  inactivityMs: number | undefined,
  onLine: (stream: "stdout" | "stderr", text: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn ${cmd}: ${err}`));
    }

    let killed = false;
    const kill = (reason: string) => {
      if (killed) return;
      killed = true;
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      try { child.kill("SIGKILL"); } catch {}
      setTimeout(() => reject(new Error(reason)), 1000);
    };

    const hardTimer = setTimeout(() => {
      kill(`${cmd} timed out after ${timeoutMs / 1000}s`);
    }, timeoutMs);

    let inactivityTimer: NodeJS.Timeout | null = null;
    const resetInactivity = () => {
      if (!inactivityMs) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        kill(`${cmd} killed: no output for ${inactivityMs / 1000}s`);
      }, inactivityMs);
    };

    if (inactivityMs) resetInactivity();

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      resetInactivity();
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (line.length > 0) onLine("stdout", line);
      }
    });

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      resetInactivity();
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() || "";
      for (const line of lines) {
        if (line.length > 0) onLine("stderr", line);
      }
    });

    child.on("error", (err) => {
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!killed) reject(new Error(`${cmd} process error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (killed) return;
      // Flush remaining buffered output
      if (stdoutBuf.length > 0) onLine("stdout", stdoutBuf);
      if (stderrBuf.length > 0) onLine("stderr", stderrBuf);
      resolve(code ?? 1);
    });
  });
}

function findLatestBuildProfile(configs: BuildConfig[], minTime: number): string | null {
  for (const config of configs) {
    const profileDir = path.join(
      config.mozilla_src,
      config.obj_dir,
      ".mozbuild",
      "logs",
      "build"
    );

    if (!fs.existsSync(profileDir)) continue;

    try {
      const files = fs
        .readdirSync(profileDir)
        .filter((f) => f.startsWith("profile_log_") && f.endsWith(".json"));

      if (files.length === 0) continue;

      const sorted = files
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(profileDir, f)).mtimeMs,
        }))
        .filter((f) => f.mtime >= minTime)
        .sort((a, b) => b.mtime - a.mtime);

      if (sorted.length > 0) {
        return path.join(profileDir, sorted[0].name);
      }
    } catch {
      // continue to next config
    }
  }
  return null;
}

export function getUpdateLogPath(updateId: string): string | null {
  const logPath = path.join(UPDATES_DIR, `${updateId}.log`);
  return fs.existsSync(logPath) ? logPath : null;
}
