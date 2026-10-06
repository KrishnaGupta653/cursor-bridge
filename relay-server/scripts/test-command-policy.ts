import assert from "node:assert/strict";
import { evaluateCommandPolicy } from "../lib/command-policy.ts";

const CHAT = "aaaaaaaa-1111-2222-3333-444444444444";
const cases = [
  { messageType: "execute_command", commandRaw: "git status" },
  { messageType: "execute_command", commandRaw: "git reset --hard HEAD~1" },
  { messageType: "execute_command", commandRaw: "rm -rf /" },
  { messageType: "execute_action", data: { action: "terminal" } },
  { messageType: "insert_text", data: { terminal: true, prompt: true } },
  { messageType: "insert_text", data: { terminal: "true", prompt: true } },
  { messageType: "insert_text", data: { terminal: 1, prompt: true } },
  { messageType: "insert_text", commandRaw: "rm -rf /" },
  { messageType: "unknown" },
  { messageType: "get_sessions", data: { type: "execute_command" } },
  { messageType: "agent_prompt" },
  { messageType: "approve_action", data: { chatId: CHAT, requestId: "req-abc123" } },
  { messageType: "approve_action", data: { chatId: CHAT, confirmed: true } },
  { messageType: "reject_action", data: { chatId: CHAT, requestId: "Allow", confirmed: true } },
  { messageType: "approve_action", data: { requestId: "req-abc123", confirmed: true } },
  { messageType: "get_chat", data: { chatId: "../etc" } },
  { messageType: "get_file_diff", data: { chatId: CHAT } },
  { messageType: "set_mode", data: { mode: "Root" } },
  { messageType: "set_model", data: {} },
];
for (const input of cases) assert.equal(evaluateCommandPolicy(input).decision, "deny");
for (const input of [
  { messageType: "get_sessions" },
  { messageType: "insert_text", data: { prompt: true } },
  { messageType: "agent_prompt", data: { sessionId: "selected" } },
  { messageType: "chat_response", deviceType: "pc" },
  { messageType: "list_chats", data: { query: "login" } },
  { messageType: "get_chat", data: { chatId: CHAT, before: 10 } },
  { messageType: "watch_chat", data: { chatId: CHAT, fromTotal: 4 } },
  { messageType: "unwatch_chat" },
  { messageType: "get_file_diff", data: { chatId: CHAT, path: "src/a.ts" } },
  { messageType: "agent_prompt", data: { chatId: CHAT, text: "hi" } },
  { messageType: "agent_prompt", data: { newChat: true, text: "hi" } },
  { messageType: "set_mode", data: { mode: "Plan" } },
  { messageType: "set_model", data: { model: "gpt-5" } },
  { messageType: "agent_stop", data: { chatId: CHAT } },
  { messageType: "approve_action", data: { chatId: CHAT, requestId: "req-abc123", confirmed: true } },
  { messageType: "reject_action", data: { chatId: CHAT, requestId: "req-abc123", confirmed: true } },
]) assert.equal(evaluateCommandPolicy(input).decision, "allow");
console.log("PASS: 19 denied capability/alias cases and 16 allowed typed messages");
