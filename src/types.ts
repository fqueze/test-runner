export interface BuildConfig {
  name: string;
  mozilla_src: string;
  obj_dir: string;
}

export interface AppConfig {
  port: number;
  configs: BuildConfig[];
}

export type RunStatus = "PASS" | "FAIL" | "ERROR" | "TIMEOUT";

export interface Run {
  run_id: string;
  request_id: string;
  test: string;
  config: string;
  extra_args: string[];
  status: RunStatus | null;
  reproduced: boolean;
  exit_code: number | null;
  error: string | null;
  summary: string | null;
  duration_seconds: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  log_path: string | null;
  profile_path: string | null;
  revision: string | null;
}

// WebSocket messages: Server → Client

export interface WsConfigsMessage {
  type: "configs";
  configs: { name: string }[];
}

export interface WsRunQueuedMessage {
  type: "run_queued";
  request_id: string;
  run_id: string;
  test: string;
  config: string;
}

export interface WsRunStartedMessage {
  type: "run_started";
  run_id: string;
  test: string;
  config: string;
}

export interface WsRunCompletedMessage {
  type: "run_completed";
  run_id: string;
  request_id: string;
  config: string;
  test: string;
  status: RunStatus;
  reproduced: boolean;
  duration_seconds: number;
  exit_code: number;
  summary: string;
}

export interface WsRunErrorMessage {
  type: "run_error";
  run_id: string;
  request_id: string;
  error: string;
}

export type WsServerMessage =
  | WsConfigsMessage
  | WsRunQueuedMessage
  | WsRunStartedMessage
  | WsRunCompletedMessage
  | WsRunErrorMessage;

// WebSocket messages: Client → Server

export interface WsRunRequest {
  type: "run";
  request_id: string;
  test: string;
  config: string;
  extra_args?: string[];
}

export type WsClientMessage = WsRunRequest;

// History entry (stored in history.jsonl)

export interface HistoryEntry {
  run_id: string;
  test: string;
  config: string;
  status: RunStatus;
  reproduced: boolean;
  exit_code: number;
  created_at: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  revision: string;
}

// History entry as returned by GET /api/history (with staleness check)
export interface HistoryEntryWithStaleness extends HistoryEntry {
  stale: boolean;
}
