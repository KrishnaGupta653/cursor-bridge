// 메시지 타입 정의

export type DeviceType = "mobile" | "pc";

export interface RelayMessage {
  id: string;
  type: string;
  /** "relay" marks notices the relay itself queues (e.g. `device_paired`). */
  from: DeviceType | "relay";
  to: DeviceType;
  data: Record<string, unknown>;
  timestamp: number;
  senderDeviceId?: string; // 요청을 보낸 클라이언트 ID
  targetDeviceId?: string; // 응답을 받을 클라이언트 ID (유니캐스트)
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
  /** PC가 마지막으로 폴링한 시각(ms). 없으면 PC 비연결/구버전. */
  pcLastSeenAt?: number;
  mobileDeviceIds?: string[]; // 멀티 클라이언트 지원을 위해 배열로 변경
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

// Redis 키 패턴
export const REDIS_KEYS = {
  // 세션 정보
  session: (sessionId: string) => `session:${sessionId}`,
  // 세션의 모바일 디바이스 (Sorted set: deviceId → 마지막 폴링 시각 ms)
  sessionMobiles: (sessionId: string) => `session:${sessionId}:mobiles`,
  // PC가 마지막으로 폴링한 시각(ms)
  pcLastSeen: (sessionId: string) => `session:${sessionId}:pc-seen`,
  // 메시지 큐 (PC → Mobile) - 세션 단위 (no longer written; only deleted with the session)
  messagesPC2Mobile: (sessionId: string) => `messages:${sessionId}:pc2mobile`,
  // 메시지 큐 (Mobile → PC) - 세션 단위
  messagesMobile2PC: (sessionId: string) => `messages:${sessionId}:mobile2pc`,
  // 메시지 큐 (PC → 특정 Mobile 클라이언트) - 클라이언트별 큐
  messagesForDevice: (sessionId: string, deviceId: string) =>
    `messages:${sessionId}:device:${deviceId}`,
  // 커맨드 이벤트 로그 (세션별 타임라인)
  commandEvents: (sessionId: string) => `events:${sessionId}:commands`,
} as const;

// TTL 설정 (초)
export const TTL = {
  session: 24 * 60 * 60, // 24시간
  message: 5 * 60, // 5분
} as const;
