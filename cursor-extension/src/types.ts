/**
 * Type definitions for Cursor Remote Extension
 */

import * as vscode from "vscode";
import { CommandHandler } from "./command-handler";
import { WebSocketServer } from "./websocket-server";

// Cursor Agent mode
export type AgentMode = "agent" | "ask" | "plan" | "debug" | "auto";

export interface CommandMessage {
  id?: string;
  type: string;
  text?: string;
  terminal?: boolean | string;
  prompt?: boolean | string;
  execute?: boolean;
  command?: string;
  args?: any[];
  action?: string;
  clientId?: string; // Client identifier (for session isolation)
  newSession?: boolean; // Whether to start a new session (decided by the client)
  sessionId?: string; // Session ID (for chat history lookup)
  relaySessionId?: string; // Relay session ID (limits history to the current relay session)
  limit?: number; // Result limit (for chat history lookup)
  agentMode?: AgentMode; // Agent mode (agent, ask, plan, debug, auto)
  senderDeviceId?: string; // In relay mode, ID of the mobile device that sent the request (for unicast replies)
  /** Prefer CLI or existing IDE Agent (CDP). */
  agentBackend?: "cli" | "cdp";
  requestId?: string;
  /** Agents sidebar history row id (CDP DOM scrape). */
  historyId?: string;
  /** Agents-window chat ID (matches the transcript folder name). */
  chatId?: string;
  /** Sidebar group of chatId, used to expand it when the row is hidden. */
  group?: string;
  newChat?: boolean;
  /** get_chat paging: return items with seq below this. */
  before?: number;
  /** watch_chat: number of items the client already has. */
  fromTotal?: number;
  query?: string;
  offset?: number;
  expand?: boolean;
  path?: string;
  model?: string;
  mode?: string;
  /** approve_action/reject_action: the user confirmed this exact request. */
  confirmed?: boolean;
}

export interface CommandResult {
  success: boolean;
  command_type?: string;
  message?: string;
  result?: any;
  error?: string;
  path?: string;
  data?: any;
}

export interface ChatResponseMessage {
  type: "chat_response";
  text: string;
  timestamp: string;
  source?: "ide" | "cli" | "hook" | "cdp";
  sessionId?: string; // Current session ID (lets the client track it)
  clientId?: string; // Client ID (which client owns the session)
}

export interface TerminalOutputMessage {
  type: "terminal_output";
  text: string;
  timestamp: string;
}

export interface UserMessage {
  type: "user_message";
  text: string;
  timestamp: string;
}

export type WebSocketMessage =
  | ChatResponseMessage
  | TerminalOutputMessage
  | UserMessage
  | CommandResult;

export interface ExtensionContext {
  outputChannel: vscode.OutputChannel;
  wsServer: WebSocketServer;
  commandHandler: CommandHandler;
  statusBarItem: vscode.StatusBarItem;
}
