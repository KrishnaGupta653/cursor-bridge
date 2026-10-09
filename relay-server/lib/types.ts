// Message type definitions

export type DeviceType = "mobile" | "pc";

export interface RelayMessage {
  id: string;
  type: string;
  /** "relay" marks notices the relay itself queues (e.g. `device_paired`). */
  from: DeviceType | "relay";
  to: DeviceType;
  data: Record<string, unknown>;
  timestamp: number;
  senderDeviceId?: string; // client that sent the request
  targetDeviceId?: string; // client that should receive the reply (unicast)
}

export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
  sessionId: string;
  connectedAt: number;
  lastSeen: number;
}

export interface Session {
  sessionId: string;
  pcDeviceId?: string;
  /** When the PC last polled (ms). Absent if the PC is not connected or runs an old version. */
  pcLastSeenAt?: number;
  mobileDeviceIds?: string[]; // array to support multiple clients
  createdAt: number;
  expiresAt: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PolicyDecision = "allow" | "approval_required" | "deny";
export type ApprovalStatus =
  | "not_required"
  | "pending"
  | "approved"
  | "rejected";

export interface CommandEvent {
  event_id: string;
  session_id: string;
  timestamp: number;
  tool: {
    provider: "cursor" | "codex" | "other";
    name: string;
  };
  command: {
    raw: string;
    cwd?: string;
  };
  risk: {
    level: RiskLevel;
    reasons: string[];
  };
  policy: {
    decision: PolicyDecision;
    rule_id?: string;
  };
  approval: {
    required: boolean;
    status: ApprovalStatus;
    approved_by?: string | null;
    approved_at?: number | null;
    reason?: string | null;
  };
  result: {
    status: "pending" | "running" | "success" | "error" | "cancelled" | "timeout";
    exit_code?: number | null;
    duration_ms?: number;
    error_message?: string | null;
  };
  metadata?: Record<string, unknown>;
}

// Redis key patterns
export const REDIS_KEYS = {
  session: (sessionId: string) => `session:${sessionId}`,
  // Session's mobile devices (sorted set: deviceId → last poll time in ms)
  sessionMobiles: (sessionId: string) => `session:${sessionId}:mobiles`,
  // When the PC last polled (ms)
  pcLastSeen: (sessionId: string) => `session:${sessionId}:pc-seen`,
  // Message queue (PC → Mobile), per session (no longer written; only deleted with the session)
  messagesPC2Mobile: (sessionId: string) => `messages:${sessionId}:pc2mobile`,
  // Message queue (Mobile → PC), per session
  messagesMobile2PC: (sessionId: string) => `messages:${sessionId}:mobile2pc`,
  // Message queue (PC → one specific mobile client), per client
  messagesForDevice: (sessionId: string, deviceId: string) =>
    `messages:${sessionId}:device:${deviceId}`,
  // Command event log (per-session timeline)
  commandEvents: (sessionId: string) => `events:${sessionId}:commands`,
} as const;

// TTLs (seconds)
export const TTL = {
  session: 24 * 60 * 60, // 24 hours
  message: 5 * 60, // 5 minutes
} as const;
