/** Typed remote capabilities. Unknown and free-form execution paths fail closed. */
const allowed = new Set([
  "get_ai_response", "get_session_info", "get_chat_history", "get_active_file",
  "save_file", "cdp_status", "get_cdp_status", "cdp_targets", "get_cdp_targets",
  "get_sessions", "sessions", "get_agent_history", "agent_history",
  "select_session", "get_agent_state", "get_agent_plan", "get_plan",
  "agent_prompt", "cli_prompt", "insert_text",
  "list_chats", "get_chat", "watch_chat", "unwatch_chat", "get_composer_state", "list_models",
  "get_file_diff", "open_chat", "new_chat", "set_model", "set_mode", "agent_stop",
  "approve_action", "reject_action", "stop_prompt",
]);

/** Commands that change what Cursor does; gated by cursorRemote.remoteActions and audited. */
export const REMOTE_ACTIONS = new Set([
  "open_chat", "new_chat", "set_model", "set_mode", "agent_stop", "approve_action", "reject_action", "stop_prompt",
]);

const CHAT_ID = /^[A-Za-z0-9-]{8,80}$/;
const REQUEST_ID = /^req-[a-z0-9]{1,16}$/;
const MODES = new Set(["Agent", "Ask", "Plan", "Debug", "Multitask"]);
const NEEDS_CHAT = new Set(["get_chat", "watch_chat", "open_chat", "get_file_diff", "approve_action", "reject_action"]);

function validChat(v: unknown): boolean {
  return typeof v === "string" && CHAT_ID.test(v);
}

export function remoteCommandError(command: {
  type: string; terminal?: unknown; prompt?: unknown; sessionId?: unknown;
  chatId?: unknown; requestId?: unknown; confirmed?: unknown; path?: unknown; mode?: unknown; model?: unknown;
  newChat?: unknown; agentBackend?: unknown;
}): string | null {
  if (!allowed.has(command.type)) return "Command is not an allowed remote capability";
  if (command.type === "insert_text" &&
      (command.terminal !== undefined && command.terminal !== false && command.terminal !== "false")) {
    return "Remote terminal input is disabled";
  }
  if (command.type === "insert_text" && command.prompt !== true && command.prompt !== "true") {
    return "Remote editor insertion is disabled; use a typed Agent prompt";
  }
  // Prompts only reach a named Agents-window chat (or a new one); a window-level sessionId
  // would type into whatever text box that window shows.
  if (command.type === "agent_prompt" && !validChat(command.chatId) && command.newChat !== true) {
    return "Open a chat first: prompts need a chatId or newChat";
  }
  if (command.type === "insert_text" && command.agentBackend !== undefined && command.agentBackend !== "cli") {
    return "Prompts to Cursor windows go through Agents-window chats";
  }
  if (NEEDS_CHAT.has(command.type) && !validChat(command.chatId)) return "Valid chatId required";
  if ((command.type === "approve_action" || command.type === "reject_action")) {
    if (typeof command.requestId !== "string" || !REQUEST_ID.test(command.requestId)) {
      return "The exact pending requestId is required";
    }
    if (command.confirmed !== true) return "Approve and reject must be confirmed";
  }
  if (command.type === "get_file_diff" &&
      (typeof command.path !== "string" || !command.path || command.path.length > 1024 || command.path.includes("\0"))) {
    return "Valid file path required";
  }
  if (command.type === "set_mode" && (typeof command.mode !== "string" || !MODES.has(command.mode))) {
    return "Mode must be Agent, Ask, Plan, Debug or Multitask";
  }
  if (command.type === "set_model" &&
      (typeof command.model !== "string" || !command.model.trim() || command.model.length > 80)) {
    return "Model name required";
  }
  return null;
}
