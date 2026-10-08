import { SecurityError, type Principal } from "../lib/relay-security.js";
import { withRelayAuth, relaySecurity, securityFailure, logUnexpected } from "../lib/relay-auth.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendMessage, getSession, appendCommandEvent } from "../lib/store.js";
import { evaluateCommandPolicy } from "../lib/command-policy.js";
import {
  ApiResponse,
  RelayMessage,
  DeviceType,
  CommandEvent,
} from "../lib/types.js";

interface SendRequest {
  sessionId?: string;
  deviceId: string;
  deviceType: DeviceType;
  type: string;
  data: Record<string, unknown>;
  targetDeviceId?: string; // 유니캐스트 응답용 - 특정 클라이언트에게만 전송
}

/** Phone commands are small. Mac replies (chat pages, diffs up to 256 KB of text) stay under Vercel's 4.5 MB cap. */
const MAX_BODY_BYTES: Record<Principal["role"], number> = {
  mobile: 256 * 1024,
  pc: 4 * 1024 * 1024,
};

function bodyBytes(req: VercelRequest): number {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const raw = req.body;
  if (raw == null) return 0;
  return Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw));
}

// UUID 생성
function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function extractCommandRaw(
  type: string,
  data: Record<string, unknown>
): string | undefined {
  if (type !== "execute_command") return undefined;
  const candidates = [data?.command, data?.raw, data?.cmd];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeDataWithCommandId(
  type: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...(data || {}) };
  if (type !== "execute_command") return normalized;
  if (typeof normalized.id === "string" && normalized.id.trim()) {
    return normalized;
  }
  normalized.id = `cmd_${generateMessageId()}`;
  return normalized;
}

function extractCommandId(data: Record<string, unknown>): string | null {
  return typeof data.id === "string" && data.id.trim() ? data.id : null;
}

async function handler(req: VercelRequest, res: VercelResponse, principal: Principal) {
  // CORS 헤더 설정
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Device-Id, X-Device-Type"
  );
  res.setHeader("Access-Control-Max-Age", "86400"); // 24시간

  // CORS preflight - OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Device-Id, X-Device-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.method !== "POST") {
    const response: ApiResponse = {
      success: false,
      error: "Method not allowed",
      timestamp: Date.now(),
    };
    return res.status(405).json(response);
  }

  if (bodyBytes(req) > MAX_BODY_BYTES[principal.role]) {
    return res.status(413).json({ success: false, errorCode: "PAYLOAD_TOO_LARGE", error: "Request body too large", timestamp: Date.now() });
  }

  try {
    // Session, device and role were set from the credential by authorize.
    const {
      sessionId,
      deviceId,
      deviceType,
      type,
      data: rawData,
      targetDeviceId: providedTargetDeviceId,
    } = (req.body || {}) as SendRequest;
    const data = normalizeDataWithCommandId(type, rawData || {});

    // 입력 검증
    if (!sessionId || !deviceId || !deviceType || !type) {
      const response: ApiResponse = {
        success: false,
        error: "deviceId, deviceType, and type are required",
        timestamp: Date.now(),
      };
      return res.status(400).json(response);
    }

    // 세션 존재 확인
    const session = await getSession(sessionId);
    if (!session) {
      const response: ApiResponse = {
        success: false,
        error: "Session not found",
        timestamp: Date.now(),
      };
      return res.status(404).json(response);
    }

    // 대상 디바이스 타입 결정
    const targetType: DeviceType = deviceType === "pc" ? "mobile" : "pc";

    // targetDeviceId 결정 (body에서 직접 전달받거나 data에서 추출)
    const targetDeviceId = providedTargetDeviceId || (data?.targetDeviceId as string | undefined);
    if (targetDeviceId && (typeof targetDeviceId !== "string" ||
        (deviceType === "pc" ? !session.mobileDeviceIds?.includes(targetDeviceId) : targetDeviceId !== session.pcDeviceId))) {
      throw new SecurityError(403, "TARGET_MEMBERSHIP_REQUIRED");
    }

    // 정책 평가 (execute_command 기준 게이팅)
    const commandRaw = extractCommandRaw(type, data || {});
    const policy = evaluateCommandPolicy({ messageType: type, commandRaw, data, deviceType });

    const commandEvent: CommandEvent | null = commandRaw
      ? {
          event_id: `evt_${generateMessageId()}`,
          session_id: sessionId,
          timestamp: Date.now(),
          tool: {
            provider: "cursor",
            name: "relay-server",
          },
          command: {
            raw: commandRaw,
            cwd: typeof data?.cwd === "string" ? data.cwd : undefined,
          },
          risk: {
            level: policy.riskLevel,
            reasons: policy.reasons,
          },
          policy: {
            decision: policy.decision,
            rule_id: policy.ruleId,
          },
          approval: {
            required: false,
            status: "not_required",
            approved_by: null,
            approved_at: null,
            reason: null,
          },
          result: {
            status: policy.decision === "deny" ? "error" : "success",
            error_message: policy.decision === "deny" ? "Command denied by policy" : null,
            duration_ms: 0,
            exit_code: null,
          },
          metadata: {
            sender_device_id: deviceId,
            target_device_id: targetDeviceId || null,
            message_type: type,
            command_id: extractCommandId(data),
          },
        }
      : null;

    // Claimed before it is audited or delivered, so a replay is neither logged nor run twice.
    if (principal.role === "mobile" && (commandEvent || policy.decision !== "deny") &&
        !await relaySecurity.claimCommand(principal, data.id, data.deadline)) {
      return res.status(409).json({ success: false, errorCode: "DUPLICATE_COMMAND", error: "Command already accepted", timestamp: Date.now() });
    }

    if (commandEvent) {
      try {
        await appendCommandEvent(sessionId, commandEvent);
      } catch (error) {
        logUnexpected(req, error, "COMMAND_EVENT_NOT_PERSISTED");
      }
      console.info("[command_event]", commandEvent.event_id, policy.decision);
    }

    if (policy.decision === "deny") {
      const response: ApiResponse<{
        policyDecision: string;
        riskLevel: string;
        reasons: string[];
      }> = {
        success: false,
        error: "Command blocked by security policy",
        data: {
          policyDecision: policy.decision,
          riskLevel: policy.riskLevel,
          reasons: policy.reasons,
        },
        timestamp: Date.now(),
      };
      return res.status(403).json(response);
    }

    // 메시지 생성
    const message: RelayMessage = {
      id: generateMessageId(),
      type,
      from: deviceType,
      to: targetType,
      data: data || {},
      timestamp: Date.now(),
      senderDeviceId: deviceId,  // 요청자 ID 포함 (유니캐스트 응답용)
      targetDeviceId: targetDeviceId,  // 유니캐스트 응답용 - 특정 클라이언트에게만 전송
    };

    // 메시지 큐에 추가: a reply goes only to the phone that asked; anything else to every live phone
    const recipients = targetDeviceId ? [targetDeviceId] : session.mobileDeviceIds ?? [];
    await sendMessage(sessionId, message, recipients);

    const response: ApiResponse<{
      messageId: string;
      commandId: string | null;
      policyDecision: string;
      riskLevel: string;
      reasons: string[];
    }> = {
      success: true,
      data: {
        messageId: message.id,
        commandId: extractCommandId(data),
        policyDecision: policy.decision,
        riskLevel: policy.riskLevel,
        reasons: policy.reasons,
      },
      timestamp: Date.now(),
    };

    return res.status(200).json(response);
  } catch (error) {
    if (error instanceof SecurityError) return securityFailure(res, error, req);
    logUnexpected(req, error, "RELAY_OPERATION_FAILED");
    const response: ApiResponse = {
      success: false,
      error: "Relay operation failed",
      timestamp: Date.now(),
    };
    return res.status(500).json(response);
  }
}

export default withRelayAuth(handler);
