import assert from "node:assert/strict";
import { evaluateCommandPolicy } from "../lib/command-policy.ts";

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
];
for (const input of cases) assert.equal(evaluateCommandPolicy(input).decision, "deny");
for (const input of [
  { messageType: "get_sessions" },
  { messageType: "insert_text", data: { prompt: true } },
  { messageType: "agent_prompt", data: { sessionId: "selected" } },
  { messageType: "chat_response", deviceType: "pc" },
]) assert.equal(evaluateCommandPolicy(input).decision, "allow");
console.log("PASS: 11 denied capability/alias cases and 4 allowed typed messages");
