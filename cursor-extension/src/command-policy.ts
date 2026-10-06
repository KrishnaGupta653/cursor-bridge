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
