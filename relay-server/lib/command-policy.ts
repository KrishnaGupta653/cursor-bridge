import type { PolicyDecision, RiskLevel } from "./types.js";

export interface CommandPolicyInput {
  messageType: string;
  commandRaw?: string;
  data?: Record<string, unknown>;
  deviceType?: string;
}

export interface CommandPolicyResult {
  riskLevel: RiskLevel;
  reasons: string[];
  decision: PolicyDecision;
  ruleId: string;
}

/** Typed remote capabilities. Unknown and free-form execution paths fail closed. */
const allowed = new Set([
  "get_ai_response", "get_session_info", "get_chat_history", "get_active_file",
  "save_file", "cdp_status", "get_cdp_status", "cdp_targets", "get_cdp_targets",
  "get_sessions", "sessions", "get_agent_history", "agent_history",
  "select_session", "get_agent_state", "get_agent_plan", "get_plan",
  "agent_prompt", "cli_prompt", "insert_text",
]);

export function remoteCommandError(command: { type: string; terminal?: unknown; prompt?: unknown; sessionId?: unknown }): string | null {
  if (!allowed.has(command.type)) return "Command is not an allowed remote capability";
  if (command.type === "insert_text" &&
      (command.terminal !== undefined && command.terminal !== false && command.terminal !== "false")) {
    return "Remote terminal input is disabled";
  }
  if (command.type === "insert_text" && command.prompt !== true && command.prompt !== "true") {
    return "Remote editor insertion is disabled; use a typed Agent prompt";
  }
  if (command.type === "agent_prompt" &&
      (typeof command.sessionId !== "string" || !command.sessionId.trim())) {
    return "Explicit sessionId required";
  }
  return null;
}

export function evaluateCommandPolicy(input: CommandPolicyInput): CommandPolicyResult {
  // PC responses are data, not executable mobile commands. Membership must be
  // established separately by the transport; this policy is not authentication.
  const responses = new Set(["command_result", "chat_response", "chat_response_chunk",
    "chat_response_complete", "agent_state", "agent_plan", "sessions", "agent_history",
    "cdp_status", "cdp_targets", "connection_status", "log", "error", "session_info",
    "chat_history", "terminal_output"]);
  const payload = input.data || {};
  const error = input.deviceType === "pc" && responses.has(input.messageType)
    ? null : remoteCommandError({ ...payload, type: input.messageType });
  // Prevent a nested command type from bypassing the outer envelope policy.
  const mismatch = payload.type !== undefined && payload.type !== input.messageType;
  return {
    riskLevel: error || mismatch ? "high" : "low",
    reasons: error || mismatch ? [mismatch ? "envelope-type-mismatch" : "remote-capability-denied"] : [],
    decision: error || mismatch ? "deny" : "allow",
    ruleId: error || mismatch ? "remote-capability-deny" : "typed-capability-allow",
  };
}
