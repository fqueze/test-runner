import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFileSync, ChildProcess } from "child_process";
import { BuildConfig, Run, RunStatus } from "./types";
import {
  updateRun,
  getRunArtifactDir,
  appendHistory,
} from "./run-store";
import { log, logError } from "./log";
import { getRevision } from "./revision";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes hard limit
const INACTIVITY_TIMEOUT_MS = 60_000; // kill if no output for 1 minute

// Track active child PIDs so we can clean up on server shutdown
const activeChildren = new Set<number>();

export function killAllChildren(): void {
  for (const pid of activeChildren) {
    killProcessTree(pid);
  }
  activeChildren.clear();
}

export interface RunCallbacks {
  onStarted(run: Run): void;
  onCompleted(run: Run): void;
  onError(run: Run, error: string): void;
}

export async function executeTestRun(
  run: Run,
  config: BuildConfig,
  callbacks: RunCallbacks
): Promise<void> {
  const runId = run.run_id;

  // Create temp dir for raw outputs
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `test-runner-${runId}-`));
  const logPath = path.join(tmpDir, "log-raw.json");
  const runStartTime = Date.now();

  try {
    // Build mach command args
    const machArgs = [
      "test",
      run.test,
      "--headless",
      `--log-raw=${logPath}`,
      ...run.extra_args,
    ];

    const machPath = path.join(config.mozilla_src, "mach");
    const revision = getRevision(config.mozilla_src);
    log(`[${runId}] Starting: ${machPath} ${machArgs.join(" ")} (rev ${revision.slice(0, 12)})`);
    updateRun(runId, { started_at: new Date(runStartTime).toISOString(), revision });
    callbacks.onStarted(run);

    const exitCode = await spawnMach(machPath, machArgs, config.mozilla_src, DEFAULT_TIMEOUT_MS);

    const finishedAt = new Date().toISOString();
    const startedAt = run.started_at!;
    const durationSeconds = Math.round(
      (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
    );

    log(`[${runId}] Process exited with code ${exitCode} after ${durationSeconds}s`);

    // Parse raw log for results
    const { status, reproduced, summary } = parseRawLog(logPath, exitCode);
    log(`[${runId}] Result: ${status} — ${summary} (reproduced: ${reproduced})`);

    // Copy artifacts to persistent storage
    const artifactDir = getRunArtifactDir(runId);
    if (fs.existsSync(logPath)) {
      fs.copyFileSync(logPath, path.join(artifactDir, "log-raw.json"));
    }

    // Find and copy profile (only if produced during this run)
    const profileSrc = findLatestProfile(config, runStartTime);
    if (profileSrc) {
      fs.copyFileSync(profileSrc, path.join(artifactDir, "profile.json"));
    }

    updateRun(runId, {
      status,
      reproduced,
      exit_code: exitCode,
      summary,
      duration_seconds: durationSeconds,
      finished_at: finishedAt,
      log_path: path.join(artifactDir, "log-raw.json"),
      profile_path: profileSrc
        ? path.join(artifactDir, "profile.json")
        : null,
    });

    appendHistory(run);
    log(`[${runId}] Completed, artifacts in ~/.test-runner/runs/${runId}/`);
    callbacks.onCompleted(run);
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    logError(`[${runId}] Error: ${errorMsg}`);

    const finishedAt = new Date().toISOString();
    const durationSeconds = run.started_at
      ? Math.round((new Date(finishedAt).getTime() - new Date(run.started_at).getTime()) / 1000)
      : 0;

    // Save whatever log was produced before the error/timeout
    const artifactDir = getRunArtifactDir(runId);
    if (fs.existsSync(logPath)) {
      fs.copyFileSync(logPath, path.join(artifactDir, "log-raw.json"));
    }
    const profileSrc = findLatestProfile(config, runStartTime);
    if (profileSrc) {
      fs.copyFileSync(profileSrc, path.join(artifactDir, "profile.json"));
    }

    updateRun(runId, {
      status: "TIMEOUT",
      error: errorMsg,
      exit_code: -1,
      duration_seconds: durationSeconds,
      finished_at: finishedAt,
      log_path: fs.existsSync(path.join(artifactDir, "log-raw.json"))
        ? path.join(artifactDir, "log-raw.json")
        : null,
      profile_path: profileSrc
        ? path.join(artifactDir, "profile.json")
        : null,
    });

    appendHistory(run);
    log(`[${runId}] Error recorded, artifacts in ~/.test-runner/runs/${runId}/`);
    callbacks.onError(run, errorMsg);
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getDescendants(pid: number): number[] {
  try {
    const output = execFileSync("ps", ["--ppid", String(pid), "-o", "pid="], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const children = output.trim().split("\n").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    const all: number[] = [];
    for (const child of children) {
      all.push(child, ...getDescendants(child));
    }
    return all;
  } catch {
    return [];
  }
}

function killProcessTree(pid: number): void {
  // Collect entire tree before killing (killing parent first can reparent children)
  const descendants = getDescendants(pid);
  const allPids = [pid, ...descendants];
  for (const p of allPids) {
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

function spawnMach(
  machPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(machPath, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn mach: ${err}`));
    }

    activeChildren.add(child.pid!);

    let killed = false;
    const kill = (reason: string) => {
      if (killed) return;
      killed = true;
      clearTimeout(hardTimer);
      clearTimeout(inactivityTimer);
      killProcessTree(child.pid!);
      // Wait for ports to be released before rejecting
      setTimeout(() => reject(new Error(reason)), 2000);
    };

    // Hard timeout: absolute upper bound
    const hardTimer = setTimeout(() => {
      kill(`mach test timed out after ${timeoutMs / 1000}s`);
    }, timeoutMs);

    // Inactivity timeout: reset on any stdout/stderr output
    let inactivityTimer = setTimeout(() => {
      kill(`mach test killed: no output for ${INACTIVITY_TIMEOUT_MS / 1000}s`);
    }, INACTIVITY_TIMEOUT_MS);

    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        kill(`mach test killed: no output for ${INACTIVITY_TIMEOUT_MS / 1000}s`);
      }, INACTIVITY_TIMEOUT_MS);
    };

    child.stdout?.on("data", resetInactivity);
    child.stderr?.on("data", resetInactivity);

    child.on("error", (err) => {
      clearTimeout(hardTimer);
      clearTimeout(inactivityTimer);
      if (!killed) {
        reject(new Error(`mach process error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      clearTimeout(inactivityTimer);
      activeChildren.delete(child.pid!);
      if (killed) return;
      resolve(code ?? 1);
    });
  });
}

function parseRawLog(
  logPath: string,
  exitCode: number
): { status: RunStatus; reproduced: boolean; summary: string } {
  if (!fs.existsSync(logPath)) {
    return {
      status: exitCode === 0 ? "PASS" : "ERROR",
      reproduced: exitCode !== 0,
      summary: exitCode === 0 ? "completed (no log)" : `exit code ${exitCode} (no log)`,
    };
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);

  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.action === "test_end") {
        if (entry.status === "PASS" || entry.status === "OK") {
          passed++;
        } else if (entry.status === "FAIL") {
          failed++;
        } else if (entry.status === "ERROR") {
          errors++;
        }
      }
      // Catch unexpected failures in test_status (e.g. shutdown leaks)
      if (entry.action === "test_status" && entry.status === "FAIL" && entry.expected && entry.expected !== "FAIL") {
        failed++;
      }
    } catch {
      // Skip malformed lines
    }
  }

  const reproduced = failed > 0 || errors > 0 || exitCode !== 0;
  let status: RunStatus;
  if (errors > 0) {
    status = "ERROR";
  } else if (failed > 0) {
    status = "FAIL";
  } else if (exitCode !== 0) {
    status = "FAIL";
  } else {
    status = "PASS";
  }

  const summary = `${passed} passed, ${failed} failed${errors > 0 ? `, ${errors} errors` : ""}`;

  return { status, reproduced, summary };
}

function findLatestProfile(config: BuildConfig, minTime: number): string | null {
  const profileDir = path.join(
    config.mozilla_src,
    config.obj_dir,
    ".mozbuild",
    "logs",
    "test"
  );

  if (!fs.existsSync(profileDir)) return null;

  try {
    const files = fs
      .readdirSync(profileDir)
      .filter((f) => f.startsWith("profile_log_") && f.endsWith(".json"));

    if (files.length === 0) return null;

    // Sort by mtime descending, pick most recent that was created during this run
    const sorted = files
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(profileDir, f)).mtimeMs,
      }))
      .filter((f) => f.mtime >= minTime)
      .sort((a, b) => b.mtime - a.mtime);

    if (sorted.length === 0) return null;
    return path.join(profileDir, sorted[0].name);
  } catch {
    return null;
  }
}
