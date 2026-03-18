import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Run, HistoryEntry } from "./types";

const BASE_DIR = path.join(process.env.HOME || "~", ".test-runner");
const HISTORY_PATH = path.join(BASE_DIR, "history.jsonl");
const RUNS_DIR = path.join(BASE_DIR, "runs");

// In-memory store for active/recent runs
const runs = new Map<string, Run>();

export function generateRunId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export function createRun(
  runId: string,
  requestId: string,
  test: string,
  config: string,
  extraArgs: string[]
): Run {
  const run: Run = {
    run_id: runId,
    request_id: requestId,
    test,
    config,
    extra_args: extraArgs,
    status: null,
    reproduced: false,
    exit_code: null,
    error: null,
    summary: null,
    duration_seconds: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    log_path: null,
    profile_path: null,
    revision: null,
  };
  runs.set(runId, run);
  return run;
}

export function getRunArtifactPaths(runId: string): { log_path: string | null; profile_path: string | null } {
  const dir = path.join(RUNS_DIR, runId);
  const logPath = path.join(dir, "log-raw.json");
  const profilePath = path.join(dir, "profile.json");
  return {
    log_path: fs.existsSync(logPath) ? logPath : null,
    profile_path: fs.existsSync(profilePath) ? profilePath : null,
  };
}

export function getRun(runId: string): Run | undefined {
  const memRun = runs.get(runId);
  if (memRun) return memRun;

  // Fall back to on-disk artifacts for runs from previous sessions
  const artifacts = getRunArtifactPaths(runId);
  if (!artifacts.log_path && !artifacts.profile_path) return undefined;

  return {
    run_id: runId,
    request_id: "",
    test: "",
    config: "",
    extra_args: [],
    status: null,
    reproduced: false,
    exit_code: null,
    error: null,
    summary: null,
    duration_seconds: null,
    created_at: "",
    started_at: null,
    finished_at: null,
    log_path: artifacts.log_path,
    profile_path: artifacts.profile_path,
    revision: null,
  };
}

export function updateRun(runId: string, updates: Partial<Run>): Run | undefined {
  const run = runs.get(runId);
  if (!run) return undefined;
  Object.assign(run, updates);
  return run;
}

export function getRunArtifactDir(runId: string): string {
  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendHistoryEntry(entry: HistoryEntry): void {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n");
}

export function appendHistory(run: Run): void {
  fs.mkdirSync(BASE_DIR, { recursive: true });

  const entry: HistoryEntry = {
    run_id: run.run_id,
    test: run.test,
    config: run.config,
    status: run.status!,
    reproduced: run.reproduced,
    exit_code: run.exit_code!,
    created_at: run.created_at,
    started_at: run.started_at!,
    finished_at: run.finished_at!,
    duration_seconds: run.duration_seconds!,
    revision: run.revision || "unknown",
  };

  fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n");
}

export function readHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) return [];

  const lines = fs.readFileSync(HISTORY_PATH, "utf-8").trim().split("\n");
  return lines.filter((l) => l.length > 0).map((l) => JSON.parse(l));
}
