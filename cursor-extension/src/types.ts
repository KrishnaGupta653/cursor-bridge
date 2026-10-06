/**
 * Type definitions for Cursor Remote Extension
 */

import * as vscode from "vscode";
import { CommandHandler } from "./command-handler";
import { WebSocketServer } from "./websocket-server";

// Cursor Agent 모드 타입
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
  clientId?: string; // 클라이언트 식별자 (세션 격리용)
  newSession?: boolean; // 새 세션 시작 여부 (클라이언트에서 결정)
  sessionId?: string; // 세션 ID (대화 히스토리 조회용)
  relaySessionId?: string; // 릴레이 세션 ID (현재 릴레이 세션 히스토리만 조회)
  limit?: number; // 조회 제한 (대화 히스토리 조회용)
  agentMode?: AgentMode; // 에이전트 모드 (agent, ask, plan, debug, auto)
  senderDeviceId?: string; // 릴레이 모드에서 요청을 보낸 모바일 디바이스 ID (유니캐스트 응답용)
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
  sessionId?: string; // 현재 세션 ID (클라이언트가 추적 가능)
  clientId?: string; // 클라이언트 ID (어떤 클라이언트의 세션인지)
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
