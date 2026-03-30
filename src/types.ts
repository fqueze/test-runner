export interface BuildConfig {
  name: string;
  mozilla_src: string;
  obj_dir: string;
}

export interface PeerConfig {
  address: string;
}

export interface AppConfig {
  port: number;
  configs: BuildConfig[];
  peers?: PeerConfig[];
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
  configs: { name: string; revision?: string; branch?: string; mozilla_src?: string; local?: boolean }[];
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
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  revision?: string;
}

export interface WsRunErrorMessage {
  type: "run_error";
  run_id: string;
  request_id: string;
  error: string;
}

export interface WsUpdateStartedMessage {
  type: "update_started";
  update_id: string;
}

export interface WsUpdateOutputMessage {
  type: "update_output";
  update_id: string;
  source_tree: string;
  stream: "stdout" | "stderr" | "status";
  text: string;
}

export interface WsUpdateCompletedMessage {
  type: "update_completed";
  update_id: string;
  success: boolean;
  results: UpdateResult[];
}

export interface UpdateResult {
  source_tree: string;
  success: boolean;
  new_revision?: string;
  error?: string;
  profile_path?: string;
  duration_seconds?: number;
  started_at?: string;
  finished_at?: string;
}

export type WsServerMessage =
  | WsConfigsMessage
  | WsRunQueuedMessage
  | WsRunStartedMessage
  | WsRunCompletedMessage
  | WsRunErrorMessage
  | WsUpdateStartedMessage
  | WsUpdateOutputMessage
  | WsUpdateCompletedMessage;

// WebSocket messages: Client → Server

export interface WsRunRequest {
  type: "run";
  request_id: string;
  test: string;
  config: string;
  extra_args?: string[];
}

export interface WsUpdateRequest {
  type: "update_builds";
  update_id: string;
  configs?: string[];
  revision?: string;
}

export type WsClientMessage = WsRunRequest | WsUpdateRequest;

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
  kind?: "test" | "update";
  profile_path?: string;
}

// History entry as returned by GET /api/history (with staleness check)
export interface HistoryEntryWithStaleness extends HistoryEntry {
  stale: boolean;
}
