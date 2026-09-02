/**
 * CDP / Existing Cursor Agent session types.
 * Application-level only — never expose raw CDP method proxying to clients.
 */

export type AgentSessionState =
  | "IDLE"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "WAITING_FOR_PERMISSION"
  | "COMPLETED"
  | "ERROR"
  | "UNKNOWN";

/** Honest capability reporting — never fake success. */
export type SupportLevel =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "NOT_CURRENTLY_ACCESSIBLE";

export interface CdpTargetInfo {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
  description?: string;
  attached: boolean;
  score?: number;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp?: string;
  status?: string;
}

export interface PermissionRequest {
  id: string;
  title: string;
  detail: string;
  rawText?: string;
}

export interface AgentPlanStep {
  id: string;
  text: string;
  status: "pending" | "running" | "completed" | "unknown";
}

export interface AgentPlan {
  title: string;
  steps: AgentPlanStep[];
  available: boolean;
  support: SupportLevel;
}

export interface FileChangeInfo {
  path: string;
  changeType: "modified" | "added" | "deleted" | "unknown";
}

export interface FileChanges {
  items: FileChangeInfo[];
  available: boolean;
  support: SupportLevel;
  note?: string;
}

export interface ActivityEvent {
  id: string;
  text: string;
  kind:
    | "started"
    | "reading"
    | "command"
    | "permission"
    | "thinking"
    | "completed"
    | "error"
    | "info";
  timestamp: string;
}

export interface CursorSessionSnapshot {
  id: string;
  targetId: string;
  title: string;
  workspace?: string;
  model?: string;
  url: string;
  state: AgentSessionState;
  connected: boolean;
  lastActivity: string;
  latestMessage?: string;
  latestActivity?: string;
  messages: AgentMessage[];
  plan: AgentPlan | null;
  pendingApproval: PermissionRequest | null;
  fileChanges: FileChanges;
  activity: ActivityEvent[];
  extractionNotes?: string[];
  capabilities?: {
    conversation: SupportLevel;
    plan: SupportLevel;
    permissions: SupportLevel;
    promptInject: SupportLevel;
    fileChanges: SupportLevel;
  };
}

export interface SessionListItem {
  id: string;
  title: string;
  workspace?: string;
  state: AgentSessionState | string;
  connected: boolean;
  targetId: string;
  latestMessage?: string;
  latestActivity?: string;
  lastActivity?: string;
  hasPendingPermission?: boolean;
  kind?: "live" | "history" | "pinned";
  relativeTime?: string;
  group?: string;
}

export interface AgentHistoryItem {
  id: string;
  title: string;
  relativeTime?: string;
  group: string;
  kind: "history" | "pinned";
}

export interface AgentHistoryPayload {
  available: boolean;
  support: SupportLevel;
  items: AgentHistoryItem[];
  count: number;
  note?: string;
  sourceSessionId?: string;
}

export interface CdpStatusPayload {
  type: "cdp_status";
  enabled: boolean;
  connected: boolean;
  host: string;
  port: number;
  activeSessionId: string | null;
  targets: CdpTargetInfo[];
  error?: string;
  summary?: {
    working: number;
    waiting: number;
    idle: number;
    error: number;
  };
}

export interface DomExtractionResult {
  messages: AgentMessage[];
  state: AgentSessionState;
  pendingApproval: PermissionRequest | null;
  plan: AgentPlan | null;
  fileChanges: FileChanges;
  activity: ActivityEvent[];
  workspace?: string;
  model?: string;
  latestActivity?: string;
  notes: string[];
  fingerprint: string;
}
