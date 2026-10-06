/**
 * Command routing module for handling WebSocket commands
 */

import { CommandHandler } from "./command-handler";
import { WebSocketServer } from "./websocket-server";
import { CommandMessage, CommandResult } from "./types";
import * as vscode from "vscode";
import { REMOTE_ACTIONS, remoteCommandError } from "./command-policy";
import { AgentsWindow, SidebarRow } from "./cdp/agents-window";
import { ChatWatcher } from "./chat-watcher";
import { TranscriptIndex } from "./transcripts/transcript-index";
import { WorkspaceDiff, diffFromSnippets } from "./transcripts/workspace-diff";

export interface ChatServices {
  index: TranscriptIndex;
  diff: WorkspaceDiff;
  watcher: ChatWatcher;
  agents: () => AgentsWindow | null;
  remoteActionsEnabled: () => boolean;
}

export function channelOf(clientId: string | undefined): "relay" | "telegram" | "local" {
  if (clientId?.startsWith("relay:")) return "relay";
  if (clientId?.startsWith("telegram:")) return "telegram";
  return "local";
}

export class CommandRouter {
  private commandHandler: CommandHandler;
  private wsServer: WebSocketServer;
  private outputChannel: vscode.OutputChannel;
  private chat: ChatServices | null = null;

  setChatServices(services: ChatServices | null): void {
    this.chat = services;
  }

  /** One line per remote action: channel, action, chat. Never includes prompt text or credentials. */
  private audit(command: CommandMessage, ok: boolean, detail = ""): void {
    const chatId = typeof command.chatId === "string" ? command.chatId : "-";
    this.outputChannel.appendLine(
      `[${new Date().toISOString()}] [Audit] channel=${channelOf(command.clientId)} action=${command.type} chat=${chatId} result=${ok ? "ok" : "refused"}${detail ? ` ${detail}` : ""}`
    );
  }

  constructor(
    commandHandler: CommandHandler,
    wsServer: WebSocketServer,
    outputChannel: vscode.OutputChannel
  ) {
    this.commandHandler = commandHandler;
    this.wsServer = wsServer;
    this.outputChannel = outputChannel;
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(logMessage);
    console.log(logMessage);
  }

  private logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const logMessage = `[${timestamp}] ❌ ${message}: ${errorMsg}`;
    this.outputChannel.appendLine(logMessage);
    console.error(logMessage);
  }

  private extractExitCode(payload: Record<string, any>): number | null {
    const candidates = [
      payload.exit_code,
      payload.exitCode,
      payload.result?.exit_code,
      payload.result?.exitCode,
    ];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  /**
   * Handle incoming command
   */
  async handleCommand(command: CommandMessage): Promise<void> {
    if (!this.commandHandler || !this.wsServer) {
      return;
    }

    const commandId = command.id || Date.now().toString();
    this.log(
      `HandleCommand: type=${command.type}, clientId=${
        command.clientId || "none"
      }`
    );

    const startedAt = Date.now();
    try {
      const policyError = remoteCommandError(command);
      if (policyError) {
        if (REMOTE_ACTIONS.has(command.type)) this.audit(command, false, "policy");
        throw new Error(policyError);
      }
      if (REMOTE_ACTIONS.has(command.type) && this.chat && !this.chat.remoteActionsEnabled()) {
        this.audit(command, false, "disabled");
        throw new Error("Remote actions are turned off on this Mac (cursorRemote.remoteActions)");
      }
      let result: CommandResult | null = null;

      switch (command.type) {
        case "insert_text":
          result = await this.handleInsertText(command);
          break;
        case "execute_command":
          result = await this.handleExecuteCommand(command);
          break;
        case "get_ai_response":
          result = await this.handleGetAIResponse();
          break;
        case "get_session_info":
          result = await this.handleGetSessionInfo(command);
          break;
        case "get_chat_history":
          result = await this.handleGetChatHistory(command);
          break;
        case "get_active_file":
          result = await this.handleGetActiveFile();
          break;
        case "save_file":
          result = await this.handleSaveFile();
          break;
        case "stop_prompt":
          result = await this.handleStopPrompt();
          break;
        case "execute_action":
          result = await this.handleExecuteAction(command);
          break;
        case "cdp_status":
        case "get_cdp_status":
          result = await this.handleCdpStatus(command);
          break;
        case "cdp_targets":
        case "get_cdp_targets":
          result = await this.handleCdpTargets(command);
          break;
        case "get_sessions":
        case "sessions":
          result = await this.handleGetSessions(command);
          break;
        case "get_agent_history":
        case "agent_history":
          result = await this.handleGetAgentHistory(command);
          break;
        case "open_agent_history":
          result = await this.handleOpenAgentHistory(command);
          break;
        case "select_session":
          result = await this.handleSelectSession(command);
          break;
        case "get_agent_state":
          result = await this.handleGetAgentState(command);
          break;
        case "get_agent_plan":
        case "get_plan":
          result = await this.handleGetAgentPlan(command);
          break;
        case "agent_prompt":
          result = await this.handleAgentPrompt(command);
          break;
        case "cli_prompt":
          result = await this.handleCliPrompt(command);
          break;
        case "approve_action":
        case "reject_action":
          result = await this.handleResolveRequest(command, command.type === "approve_action");
          break;
        case "list_chats":
          result = await this.handleListChats(command);
          break;
        case "get_chat":
          result = await this.handleGetChat(command);
          break;
        case "watch_chat":
          result = this.handleWatchChat(command);
          break;
        case "unwatch_chat":
          result = this.handleUnwatchChat(command);
          break;
        case "get_composer_state":
          result = await this.handleComposerState(command);
          break;
        case "list_models":
          result = await this.handleListModels(command);
          break;
        case "get_file_diff":
          result = await this.handleFileDiff(command);
          break;
        case "open_chat":
        case "new_chat":
        case "set_model":
        case "set_mode":
        case "agent_stop":
          result = await this.handleAgentsAction(command);
          break;
        default:
          const errorMsg = `Unknown command type: ${command.type}`;
          this.log(errorMsg);
          console.warn("Unknown command type:", command.type);
          this.wsServer.send(
            this.serializeReply(command, {
              id: commandId,
              type: "command_result",
              success: false,
              command_type: command.type,
              duration_ms: Date.now() - startedAt,
              exit_code: 1,
              error_message: errorMsg,
              error: errorMsg,
            })
          );
          return;
      }

      // result.success를 실제 응답 success에 반영
      const { success: resultSuccess = true, ...resultWithoutSuccess } =
        result || { success: true };

      if (!resultSuccess) {
        const fallbackError =
          resultWithoutSuccess.error ||
          resultWithoutSuccess.message ||
          `Command ${command.type} failed`;
        const exitCode =
          this.extractExitCode(resultWithoutSuccess as Record<string, any>) ?? 1;
        const durationMs =
          typeof (resultWithoutSuccess as any).duration_ms === "number"
            ? ((resultWithoutSuccess as any).duration_ms as number)
            : Date.now() - startedAt;
        this.log(`Command ${command.type} failed: ${fallbackError}`);
        this.wsServer.send(
          this.serializeReply(command, {
            id: commandId,
            type: "command_result",
            success: false,
            command_type: command.type,
            ...resultWithoutSuccess,
            duration_ms: durationMs,
            exit_code: exitCode,
            error_message: String(fallbackError),
            ...(resultWithoutSuccess.error
              ? {}
              : { error: String(fallbackError) }),
          })
        );
        return;
      }

      // Send success response
      const successMsg = `Command ${command.type} executed successfully`;
      const durationMs =
        typeof (resultWithoutSuccess as any).duration_ms === "number"
          ? ((resultWithoutSuccess as any).duration_ms as number)
          : Date.now() - startedAt;
      const exitCode = this.extractExitCode(
        resultWithoutSuccess as Record<string, any>
      );
      this.log(successMsg);
      this.wsServer.send(
        this.serializeReply(command, {
          id: commandId,
          type: "command_result",
          success: true,
          command_type: command.type,
          ...resultWithoutSuccess,
          duration_ms: durationMs,
          exit_code: exitCode,
          error_message: null,
        })
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError("Error handling command", error);
      console.error("Error handling command:", error);
      this.wsServer.send(
        this.serializeReply(command, {
          id: commandId,
          type: "command_result",
          success: false,
          command_type: command.type,
          duration_ms: Date.now() - startedAt,
          exit_code: 1,
          error_message: errorMsg,
          error: errorMsg,
        })
      );
    }
  }

  /**
   * Cursor 스트림 JSON(시스템/유저 라인)이 그대로 text로 오면 사용자 발화만 추출
   */
  private normalizePromptText(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return trimmed;
    // 한 줄에 하나의 JSON인 스트림 형식: {"type":"system",...}\n{"type":"user","message":{...}}
    const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim()) as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (obj.type === "user" && obj.message?.content?.length) {
          for (const c of obj.message.content) {
            if (c.type === "text" && typeof c.text === "string" && c.text) {
              return c.text.trim();
            }
          }
        }
      } catch {
        // JSON이 아니면 무시
      }
    }
    // 단일 JSON 객체로 전체가 감싸진 경우 (예: message.content[0].text)
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (obj.type === "user" && obj.message?.content?.length) {
        for (const c of obj.message.content) {
          if (c.type === "text" && typeof c.text === "string" && c.text) {
            return c.text.trim();
          }
        }
      }
    } catch {
      // 전체가 JSON이 아니면 원문 그대로 사용
    }
    return trimmed;
  }

  /**
   * Handle insert_text command
   */
  private async handleInsertText(
    command: CommandMessage
  ): Promise<CommandResult> {
    try {
      const rawText = command.text ?? "";
      const text = this.normalizePromptText(rawText);
      if (rawText !== text && text) {
        this.log(
          `insert_text: extracted user text from stream JSON (length ${rawText.length} -> ${text.length})`
        );
      }
      this.log(
        `insert_text command - terminal: ${command.terminal}, prompt: ${
          command.prompt
        }, text length: ${text.length}, clientId: ${command.clientId || "none"}`
      );

      const isTerminal =
        command.terminal === true || command.terminal === "true";
      const isPrompt = command.prompt === true || command.prompt === "true";
      const execute = command.execute === true;

      if (isTerminal) {
        this.log("Routing to terminal");
        await this.commandHandler.insertToTerminal(text, execute);
        return {
          success: true,
          message: execute
            ? "Text sent to terminal and executed"
            : "Text sent to terminal",
        };
      } else if (isPrompt) {
        this.log("Routing to prompt");
        const newSession = command.newSession === true;
        const agentMode = command.agentMode || "auto";
        const agentBackend =
          command.agentBackend === "cdp" ? "cdp" : ("cli" as const);
        await this.commandHandler.insertToPrompt(
          text,
          execute,
          command.clientId,
          newSession,
          agentMode,
          command.senderDeviceId,
          agentBackend,
          command.sessionId
        );
        return {
          success: true,
          message: execute
            ? "Text inserted to prompt and executed"
            : "Text inserted to prompt",
        };
      } else {
        this.log("Routing to editor (fallback)");
        await this.commandHandler.insertText(text);
        return { success: true, message: "Text inserted" };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError("Error in insert_text", error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Handle execute_command
   */
  private async handleExecuteCommand(
    command: CommandMessage
  ): Promise<CommandResult> {
    const result = await this.commandHandler.executeCommand(
      command.command || "",
      ...(command.args || [])
    );
    return { success: true, result: result };
  }

  /**
   * Handle get_ai_response
   */
  private async handleGetAIResponse(): Promise<CommandResult> {
    const response = await this.commandHandler.getAIResponse();
    return { success: true, data: response };
  }

  /**
   * Handle get_session_info
   */
  private async handleGetSessionInfo(
    command: CommandMessage
  ): Promise<CommandResult> {
    const clientId = command.clientId;
    const sessionInfo = await this.commandHandler.getSessionInfo(clientId);
    return { success: true, data: sessionInfo };
  }

  /**
   * Handle get_chat_history
   */
  private async handleGetChatHistory(
    command: CommandMessage
  ): Promise<CommandResult> {
    const clientId = command.clientId;
    const sessionId = (command as any).sessionId as string | undefined;
    const relaySessionId = (command as any).relaySessionId as
      | string
      | undefined;
    const limit = ((command as any).limit as number | undefined) || 50;
    const history = await this.commandHandler.getChatHistory(
      clientId,
      sessionId,
      relaySessionId,
      limit
    );
    return { success: true, data: history };
  }

  /**
   * Handle get_active_file
   */
  private async handleGetActiveFile(): Promise<CommandResult> {
    const result = await this.commandHandler.getActiveFile();
    if (result) {
      return { success: true, ...result };
    }
    return { success: false, error: "No active file" };
  }

  /**
   * Handle save_file
   */
  private async handleSaveFile(): Promise<CommandResult> {
    const result = await this.commandHandler.saveFile();
    return result;
  }

  /**
   * Handle stop_prompt
   */
  private async handleStopPrompt(): Promise<CommandResult> {
    const result = await this.commandHandler.stopPrompt();
    return result;
  }

  /**
   * Handle execute_action
   */
  private async handleExecuteAction(
    command: CommandMessage
  ): Promise<CommandResult> {
    const result = await this.commandHandler.executeAction(
      command.action || ""
    );
    return result;
  }

  private serializeReply(command: CommandMessage, payload: object): string {
    return JSON.stringify({ ...payload, clientId: command.clientId,
      targetDeviceId: command.senderDeviceId, correlationId: command.id });
  }

  private async handleCdpStatus(command: CommandMessage): Promise<CommandResult> {
    const status = await this.commandHandler.getCdpStatus();
    this.wsServer.send(this.serializeReply(command, status));
    return { success: true, data: status };
  }

  private async handleCdpTargets(command: CommandMessage): Promise<CommandResult> {
    const targets = await this.commandHandler.refreshCdpTargets();
    this.wsServer.send(this.serializeReply(command, { type: "cdp_targets", targets }));
    return { success: true, data: { targets } };
  }

  private async handleGetSessions(command: CommandMessage): Promise<CommandResult> {
    await this.commandHandler.refreshCdpTargets();
    const sessions = await this.commandHandler.listCdpSessions();
    this.wsServer.send(this.serializeReply(command, { type: "sessions", sessions }));
    const history = this.commandHandler.getCachedAgentHistory();
    this.wsServer.send(this.serializeReply(command, { type: "agent_history", ...history }));
    return { success: true, data: { sessions, history } };
  }

  private async handleGetAgentHistory(command: CommandMessage): Promise<CommandResult> {
    const history = await this.commandHandler.getAgentHistory();
    this.wsServer.send(this.serializeReply(command, { type: "agent_history", ...history }));
    return { success: true, data: history };
  }

  private async handleOpenAgentHistory(
    command: CommandMessage
  ): Promise<CommandResult> {
    const historyId = command.historyId || "";
    if (!historyId) {
      return { success: false, error: "historyId required" };
    }
    const result = await this.commandHandler.openAgentHistory(historyId);
    if (!result.ok) {
      return { success: false, error: result.error || "Failed to open history" };
    }
    return { success: true, data: result };
  }

  private async handleSelectSession(
    command: CommandMessage
  ): Promise<CommandResult> {
    const sessionId = command.sessionId || "";
    const ok = this.commandHandler.selectCdpSession(sessionId);
    if (!ok) {
      return { success: false, error: "Session not found" };
    }
    const state = await this.commandHandler.getAgentState(sessionId);
    if (state) {
      this.wsServer.send(
        this.serializeReply(command, {
          type: "agent_state",
          sessionId: state.id,
          state: state.state,
          messages: state.messages,
          plan: state.plan,
          pendingApproval: state.pendingApproval,
          title: state.title,
          workspace: state.workspace,
          model: state.model,
          fileChanges: state.fileChanges,
          activity: state.activity,
          latestMessage: state.latestMessage,
          latestActivity: state.latestActivity,
          lastActivity: state.lastActivity,
          capabilities: state.capabilities,
          extractionNotes: state.extractionNotes,
        })
      );
    }
    return { success: true, data: { sessionId } };
  }

  private async handleGetAgentState(
    command: CommandMessage
  ): Promise<CommandResult> {
    const state = await this.commandHandler.getAgentState(command.sessionId);
    if (!state) {
      return {
        success: false,
        error:
          "No Cursor Agent session available. Enable CDP and launch Cursor with --remote-debugging-port=9222.",
      };
    }
    this.wsServer.send(
      this.serializeReply(command, {
        type: "agent_state",
        sessionId: state.id,
        state: state.state,
        messages: state.messages,
        plan: state.plan,
        pendingApproval: state.pendingApproval,
        title: state.title,
        workspace: state.workspace,
        model: state.model,
        fileChanges: state.fileChanges,
        activity: state.activity,
        latestMessage: state.latestMessage,
        latestActivity: state.latestActivity,
        lastActivity: state.lastActivity,
        capabilities: state.capabilities,
        extractionNotes: state.extractionNotes,
      })
    );
    return { success: true, data: state };
  }

  private async handleGetAgentPlan(
    command: CommandMessage
  ): Promise<CommandResult> {
    const state = await this.commandHandler.getAgentState(command.sessionId);
    const plan = state?.plan || { title: "", steps: [], available: false };
    this.wsServer.send(
      this.serializeReply(command, {
        type: "agent_plan",
        sessionId: state?.id || command.sessionId || null,
        plan,
      })
    );
    return { success: true, data: { plan } };
  }

  private async handleAgentPrompt(
    command: CommandMessage
  ): Promise<CommandResult> {
    const text = this.normalizePromptText(command.text || "");
    if (!text) {
      return { success: false, error: "Empty prompt" };
    }
    if (command.chatId || command.newChat === true) return this.handleChatPrompt(command, text);
    await this.commandHandler.insertToPrompt(
      text,
      true,
      command.clientId,
      false,
      command.agentMode || "auto",
      command.senderDeviceId,
      "cdp",
      command.sessionId
    );
    return { success: true, message: "Prompt sent to existing Cursor Agent" };
  }

  private async handleCliPrompt(
    command: CommandMessage
  ): Promise<CommandResult> {
    const text = this.normalizePromptText(command.text || "");
    if (!text) {
      return { success: false, error: "Empty prompt" };
    }
    await this.commandHandler.insertToPrompt(
      text,
      true,
      command.clientId,
      command.newSession === true,
      command.agentMode || "auto",
      command.senderDeviceId,
      "cli"
    );
    return { success: true, message: "Prompt sent to Cursor CLI" };
  }

  private requireChat(): ChatServices {
    if (!this.chat) throw new Error("Chat services are not available");
    return this.chat;
  }

  private requireAgents(): AgentsWindow {
    const agents = this.requireChat().agents();
    if (!agents || !agents.attached) {
      throw new Error("Cursor Agents window is not attached. Open it in Cursor (with session control on) and try again.");
    }
    return agents;
  }

  /** Sidebar rows (authoritative for groups, pinned and status) followed by transcript-only chats. */
  private async handleListChats(command: CommandMessage): Promise<CommandResult> {
    const chat = this.requireChat();
    const agents = chat.agents();
    if (command.expand === true && agents?.attached) await agents.expandMore();
    const sidebar = agents?.attached ? await agents.sidebar() : null;
    const rows: SidebarRow[] = sidebar?.ok ? sidebar.rows : [];
    const listed = chat.index.list({ limit: 500, query: command.query });
    const byId = new Map(listed.chats.map((c) => [c.id, c]));
    const q = command.query?.trim().toLowerCase();
    const sidebarChats = rows
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.group.toLowerCase().includes(q))
      .map((r) => {
        const t = byId.get(r.id);
        return { ...r, repoName: t?.repoName ?? r.group, updatedAt: t?.updatedAt ?? null, inSidebar: true, hasTranscript: !!t };
      });
    const seen = new Set(rows.map((r) => r.id));
    const offset = Math.max(0, Number(command.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(command.limit) || 50));
    const others = listed.chats.filter((c) => !seen.has(c.id));
    const more = others.slice(offset, offset + limit).map((c) => ({
      id: c.id, title: c.title, time: "", group: c.repoName, pinned: false, status: "done",
      unread: false, active: false, repoName: c.repoName, updatedAt: c.updatedAt, inSidebar: false, hasTranscript: true,
    }));
    const payload = {
      type: "chats",
      chats: offset === 0 ? [...sidebarChats, ...more] : more,
      groups: sidebar?.ok ? sidebar.groups : [],
      sidebar: !!sidebar?.ok,
      offset,
      hasMore: offset + limit < others.length,
      totalOthers: others.length,
    };
    this.wsServer.send(this.serializeReply(command, payload));
    return { success: true, data: { count: payload.chats.length } };
  }

  private async handleGetChat(command: CommandMessage): Promise<CommandResult> {
    const chat = this.requireChat();
    const chatId = command.chatId as string;
    const page = chat.index.get(chatId, { before: command.before, limit: command.limit });
    const agents = chat.agents();
    const composer = agents?.attached ? await agents.composerState() : null;
    const state = composer?.ok && composer.state.chatId === chatId ? composer.state : null;
    if (!page && !state) return { success: false, error: "Chat not found on this Mac" };
    this.wsServer.send(this.serializeReply(command, {
      type: "chat",
      chatId,
      chat: page?.chat ?? null,
      items: page?.items ?? [],
      total: page?.total ?? 0,
      hasOlder: page?.hasOlder ?? false,
      before: command.before ?? null,
      filesChanged: page?.filesChanged ?? [],
      composer: state,
    }));
    return { success: true, data: { total: page?.total ?? 0 } };
  }

  private handleWatchChat(command: CommandMessage): CommandResult {
    const chat = this.requireChat();
    if (!command.clientId) return { success: false, error: "Unattributed watch" };
    chat.watcher.watch(
      { clientId: command.clientId, targetDeviceId: command.senderDeviceId },
      command.chatId as string,
      Math.max(0, Number(command.fromTotal) || 0)
    );
    return { success: true, message: "Watching chat" };
  }

  private handleUnwatchChat(command: CommandMessage): CommandResult {
    if (!command.clientId) return { success: false, error: "Unattributed unwatch" };
    this.requireChat().watcher.unwatch({ clientId: command.clientId, targetDeviceId: command.senderDeviceId });
    return { success: true, message: "Stopped watching" };
  }

  private async handleComposerState(command: CommandMessage): Promise<CommandResult> {
    const result = await this.requireAgents().composerState();
    if (!result.ok) return { success: false, error: result.error };
    this.wsServer.send(this.serializeReply(command, { type: "composer_state", chatId: result.state.chatId, state: result.state }));
    return { success: true };
  }

  private async handleListModels(command: CommandMessage): Promise<CommandResult> {
    const result = await this.requireAgents().listModels();
    if (!result.ok) return { success: false, error: result.error };
    this.wsServer.send(this.serializeReply(command, { type: "models", models: result.models }));
    return { success: true };
  }

  private async handleFileDiff(command: CommandMessage): Promise<CommandResult> {
    const chat = this.requireChat();
    const chatId = command.chatId as string;
    const file = String(command.path);
    const repo = chat.index.repoPath(chatId);
    let diff = await chat.diff.fileDiff(repo, file);
    if (diff && "error" in diff) return { success: false, error: diff.error };
    if (!diff || !diff.diff) {
      const snippets = chat.index.snippets(chatId, file);
      if (!diff && !snippets.length) return { success: false, error: "No diff available for this file" };
      if (snippets.length) {
        const rel = repo && file.startsWith(repo + "/") ? file.slice(repo.length + 1) : file;
        diff = diffFromSnippets(rel, snippets);
      }
    }
    this.wsServer.send(this.serializeReply(command, { type: "file_diff", chatId, ...diff }));
    return { success: true };
  }

  private async handleAgentsAction(command: CommandMessage): Promise<CommandResult> {
    const agents = this.requireAgents();
    const group = typeof command.group === "string" ? command.group : "";
    let result: { ok: boolean; error?: string; [k: string]: unknown };
    switch (command.type) {
      case "open_chat":
        result = await agents.openChat(command.chatId as string, group);
        break;
      case "new_chat":
        result = await agents.newChat();
        break;
      case "set_model": {
        const opened = await agents.ensureChat(command.chatId, group);
        result = opened.ok ? await agents.setModel(String(command.model)) : opened;
        break;
      }
      case "set_mode": {
        const opened = await agents.ensureChat(command.chatId, group);
        result = opened.ok ? await agents.setMode(String(command.mode)) : opened;
        break;
      }
      default: {
        const opened = await agents.ensureChat(command.chatId, group);
        result = opened.ok ? await agents.stop() : opened;
      }
    }
    this.audit(command, result.ok, command.type === "set_model" ? `model=${String(command.model).slice(0, 40)}` :
      command.type === "set_mode" ? `mode=${command.mode}` : "");
    if (!result.ok) return { success: false, error: result.error || `${command.type} failed` };
    const state = await agents.composerState();
    if (state.ok) {
      this.wsServer.send(this.serializeReply(command, { type: "composer_state", chatId: state.state.chatId, state: state.state }));
    }
    return { success: true, data: { ...result, chatId: state.ok ? state.state.chatId : null } };
  }

  /** Approve/reject only the exact pending request the phone showed, in the chat it showed it for. */
  private async handleResolveRequest(command: CommandMessage, approve: boolean): Promise<CommandResult> {
    const agents = this.requireAgents();
    const state = await agents.composerState();
    if (!state.ok) {
      this.audit(command, false, "no-state");
      return { success: false, error: state.error };
    }
    if (state.state.chatId !== command.chatId) {
      this.audit(command, false, "chat-mismatch");
      return { success: false, error: "That chat is no longer open in Cursor — review the request again" };
    }
    const result = await agents.resolve(command.requestId as string, approve);
    this.audit(command, result.ok, `request=${command.requestId}`);
    if (!result.ok) return { success: false, error: result.error };
    return { success: true, message: approve ? "Approved" : "Rejected", data: { label: result.label } };
  }

  /** Prompt an Agents-window chat (or a new one); the reply is detected from its transcript. */
  private async handleChatPrompt(command: CommandMessage, text: string): Promise<CommandResult> {
    const chat = this.requireChat();
    const agents = this.requireAgents();
    const opened = command.newChat === true ? await agents.newChat()
      : await agents.ensureChat(command.chatId, typeof command.group === "string" ? command.group : "");
    if (!opened.ok) return { success: false, error: opened.error };
    const chatId = command.newChat === true ? null : (command.chatId as string);
    if (command.clientId) {
      chat.watcher.awaitReply({ clientId: command.clientId, targetDeviceId: command.senderDeviceId }, chatId, command.id);
    }
    const sent = await agents.sendPrompt(text);
    this.audit(command, sent.ok, command.newChat === true ? "new-chat" : "");
    if (!sent.ok) {
      if (command.clientId) chat.watcher.forgetReply({ clientId: command.clientId, targetDeviceId: command.senderDeviceId });
      return { success: false, error: sent.error };
    }
    return { success: true, message: "Prompt sent to Cursor", data: { chatId } };
  }
}
