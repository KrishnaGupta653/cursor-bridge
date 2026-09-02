import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { CLIHandler } from "./cli-handler";
import { WebSocketServer } from "./websocket-server";
import { CONFIG } from "./config";
import { CdpManager } from "./cdp/cdp-manager";

export class CommandHandler {
  private outputChannel: vscode.OutputChannel | null = null;
  private wsServer: WebSocketServer | null = null;
  private cliHandler: CLIHandler | null = null;
  private useCLIMode: boolean = true;
  private cdpManager: CdpManager | null = null;

  constructor(
    outputChannel?: vscode.OutputChannel,
    wsServer?: WebSocketServer,
    useCLIMode: boolean = true
  ) {
    this.outputChannel = outputChannel || null;
    this.wsServer = wsServer || null;
    this.useCLIMode = useCLIMode;

    // CLI handler always available as fallback
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot =
      workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : undefined;
    this.cliHandler = new CLIHandler(outputChannel, wsServer, workspaceRoot);
    this.log("[Cursor Remote] CLI mode available");
  }

  setCdpManager(manager: CdpManager | null): void {
    this.cdpManager = manager;
  }

  /** If settings enable CDP but manager was started disabled, start it now. */
  async ensureCdpRunning(): Promise<void> {
    if (!this.cdpManager) return;
    const cfg = vscode.workspace.getConfiguration("cursorRemote");
    const enable =
      CONFIG.ENABLE_CDP || cfg.get<boolean>("enableCdp", false) === true;
    if (!enable) return;
    if (!this.cdpManager.enabled) {
      this.log("[CDP] enableCdp is on — starting CDP manager on demand");
      this.cdpManager.setEnabled(true);
      await this.cdpManager.start();
    }
  }

  async getCdpStatus() {
    await this.ensureCdpRunning();
    if (!this.cdpManager) {
      return {
        type: "cdp_status" as const,
        enabled: false,
        connected: false,
        host: CONFIG.CDP_HOST,
        port: CONFIG.CDP_PORT,
        activeSessionId: null,
        targets: [],
        error: "CDP manager not started",
      };
    }
    return this.cdpManager.getStatus();
  }

  async refreshCdpTargets() {
    await this.ensureCdpRunning();
    if (!this.cdpManager || !this.cdpManager.enabled) {
      return [];
    }
    return this.cdpManager.rediscover();
  }

  async listCdpSessions() {
    await this.ensureCdpRunning();
    return this.cdpManager?.listSessions() ?? [];
  }

  selectCdpSession(sessionId: string): boolean {
    return this.cdpManager?.selectSession(sessionId) ?? false;
  }

  async getAgentState(sessionId?: string) {
    if (!this.cdpManager) return null;
    return this.cdpManager.getAgentState(sessionId);
  }

  async approveCdpAction(sessionId?: string, requestId?: string) {
    if (!this.cdpManager) {
      return { ok: false, error: "CDP not available" };
    }
    return this.cdpManager.approveAction(sessionId, requestId);
  }

  async rejectCdpAction(sessionId?: string, requestId?: string) {
    if (!this.cdpManager) {
      return { ok: false, error: "CDP not available" };
    }
    return this.cdpManager.rejectAction(sessionId, requestId);
  }

  async getAgentHistory() {
    await this.ensureCdpRunning();
    if (!this.cdpManager) {
      return {
        available: false,
        support: "NOT_CURRENTLY_ACCESSIBLE" as const,
        items: [],
        count: 0,
        note: "CDP manager not started",
      };
    }
    return this.cdpManager.refreshAgentHistory();
  }

  getCachedAgentHistory() {
    return (
      this.cdpManager?.getAgentHistory() ?? {
        available: false,
        support: "NOT_CURRENTLY_ACCESSIBLE" as const,
        items: [],
        count: 0,
      }
    );
  }

  async openAgentHistory(historyId: string) {
    await this.ensureCdpRunning();
    if (!this.cdpManager) {
      return { ok: false, error: "CDP not available" };
    }
    return this.cdpManager.openAgentHistoryItem(historyId);
  }

  /** 릴레이 모드일 때 챗 히스토리에 relaySessionId를 넣기 위한 getter 설정 */
  setGetRelaySessionId(getter: () => string | null): void {
    this.cliHandler?.setGetRelaySessionId(getter);
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.log(logMessage);
  }

  private logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ERROR: ${message}${
      error ? ` - ${error}` : ""
    }`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.error(logMessage);
  }

  // 텍스트가 명령어인지 판단하는 헬퍼 함수
  private isLikelyCommand(text: string): boolean {
    if (!text || text.length === 0) {
      return false;
    }

    if (!text.includes(" ") && !text.includes("\t")) {
      for (const pattern of CONFIG.COMMAND_PATTERNS) {
        if (pattern.test(text)) {
          return true;
        }
      }
      return false;
    }

    for (const pattern of CONFIG.PLAIN_TEXT_PATTERNS) {
      if (pattern.test(text.trim())) {
        return false;
      }
    }

    return true;
  }

  async insertText(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("No active editor. Please open a file in Cursor IDE.");
    }

    const success = await editor.edit((editBuilder) => {
      const position = editor.selection.active;
      editBuilder.insert(position, text);
    });

    if (!success) {
      throw new Error(
        "Failed to insert text. The editor may be read-only or the edit was rejected."
      );
    }
  }

  async insertToTerminal(
    text: string,
    execute: boolean = false
  ): Promise<void> {
    this.log(
      `[Cursor Remote] insertToTerminal called - textLength: ${text.length}, execute: ${execute}`
    );
    this.log(
      `[Cursor Remote] Text content: "${text.substring(0, 100)}${
        text.length > 100 ? "..." : ""
      }"`
    );

    try {
      // 출력 파일 경로 가져오기
      const workspaceFolders = vscode.workspace.workspaceFolders;
      let outputFile: string | null = null;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        outputFile = path.join(workspaceRoot, CONFIG.TERMINAL_OUTPUT_FILE);
      }

      // 활성 터미널 가져오기
      let terminal = vscode.window.activeTerminal;
      this.log(
        `[Cursor Remote] Active terminal: ${terminal ? terminal.name : "null"}`
      );

      if (!terminal) {
        // 활성 터미널이 없으면 새 터미널 생성
        this.log("[Cursor Remote] No active terminal, creating new terminal");
        terminal = vscode.window.createTerminal("Cursor Remote");
        this.log(`[Cursor Remote] Created terminal: ${terminal.name}`);
        terminal.show(true); // true: 터미널에 포커스를 강제로 이동
        this.log(
          "[Cursor Remote] Terminal shown, waiting 800ms for activation..."
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
      } else {
        // 활성 터미널에 포커스
        this.log(`[Cursor Remote] Using existing terminal: ${terminal.name}`);
        terminal.show(true); // true: 터미널에 포커스를 강제로 이동
        this.log(
          "[Cursor Remote] Terminal shown, waiting 500ms for activation..."
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // VS Code 명령을 사용하여 터미널에 포커스 강제 이동
      this.log(
        "[Cursor Remote] Executing workbench.action.terminal.focus command..."
      );
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.TERMINAL_FOCUS_DELAY)
      );

      // 터미널이 실제로 활성화되었는지 확인
      const activeTerminalAfterWait = vscode.window.activeTerminal;
      if (activeTerminalAfterWait?.name !== terminal.name) {
        this.log(
          `[Cursor Remote] ⚠️ Warning: Terminal may not be active. Expected: ${
            terminal.name
          }, Active: ${activeTerminalAfterWait?.name || "null"}`
        );
        // 터미널이 활성화되지 않았어도 계속 진행 (터미널이 여러 개일 수 있음)
      } else {
        this.log(`[Cursor Remote] ✅ Terminal is active: ${terminal.name}`);
      }

      // 터미널에 텍스트 전송
      // execute가 false면 newline을 추가하지 않고, true면 Enter 키를 시뮬레이션
      if (execute) {
        // 터미널이 포커스를 받았는지 확인하기 위해 추가 대기
        await new Promise((resolve) => setTimeout(resolve, 100));

        // 출력 자동 캡처: 명령어처럼 보이는 경우에만 자동으로 출력을 파일로 리다이렉트
        let commandToSend = text;
        if (outputFile) {
          // 명령어인지 판단하는 로직
          const trimmedText = text.trim();
          const isCommand = this.isLikelyCommand(trimmedText);

          if (isCommand) {
            if (
              !text.includes("| tee") &&
              !text.includes(">>") &&
              !text.includes(">")
            ) {
              commandToSend = `(${text}) 2>&1 | tee -a "${outputFile}"`;
              this.log(
                `[Cursor Remote] Auto-capturing output to: ${outputFile}`
              );
            } else {
              this.log(
                `[Cursor Remote] Command already has output redirection, using as-is`
              );
            }
          } else {
            this.log(
              `[Cursor Remote] Text appears to be plain text, not capturing output`
            );
          }
        }

        // 방법: 텍스트를 newline 없이 먼저 보내고,
        // 다음 sendText 호출 시 이전 텍스트가 실행되는 특성을 이용
        terminal.sendText(commandToSend, false); // false: newline 없이 텍스트만 전송
        this.log("[Cursor Remote] Text sent, waiting for execution trigger...");

        // 충분한 대기 후 줄바꿈을 보내서 이전 텍스트 실행 트리거
        // 터미널이 텍스트를 완전히 처리할 시간을 줌
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.TERMINAL_EXECUTION_DELAY)
        );
        this.log(`[Cursor Remote] Sending execution trigger (newline)`);
        terminal.sendText("\n", false);
        this.log(
          "[Cursor Remote] ✅ Text sent to terminal with execution (triggered by newline)"
        );

        // 사용자 메시지를 모바일 앱으로 전송 (대화 히스토리용)
        if (this.wsServer) {
          this.wsServer.send(
            JSON.stringify({
              type: "user_message",
              text: text,
              timestamp: new Date().toISOString(),
            })
          );
        }
      } else {
        // 텍스트만 전송 (newline 없이)
        this.log(
          `[Cursor Remote] Sending text to terminal without execution (no newline)`
        );
        terminal.sendText(text, false);
        this.log("[Cursor Remote] ✅ Text sent to terminal (no execution)");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`[Cursor Remote] Error in insertToTerminal: ${errorMsg}`);
      this.logError(
        `[Cursor Remote] Error stack: ${
          error instanceof Error ? error.stack : "N/A"
        }`
      );
      throw new Error(`Failed to send terminal input: ${errorMsg}`);
    }
  }

  async insertToPrompt(
    text: string,
    execute: boolean = false,
    clientId?: string,
    newSession: boolean = false,
    agentMode: "agent" | "ask" | "plan" | "debug" | "auto" = "auto",
    senderDeviceId?: string,
    agentBackend: "cli" | "cdp" = "cli",
    cdpSessionId?: string
  ): Promise<void> {
    this.log(
      `[Cursor Remote] insertToPrompt called - textLength: ${
        text.length
      }, execute: ${execute}, clientId: ${
        clientId || "none"
      }, newSession: ${newSession}, agentMode: ${agentMode}, backend: ${agentBackend}, senderDeviceId: ${
        senderDeviceId || "none"
      }`
    );

    // Existing Cursor Agent via CDP (does NOT spawn CLI)
    if (agentBackend === "cdp") {
      if (!this.cdpManager || !this.cdpManager.enabled) {
        throw new Error(
          "CDP mode is not enabled. Enable cursorRemote.enableCdp and launch Cursor with --remote-debugging-port=9222."
        );
      }
      this.log("[Cursor Remote] Using CDP mode for existing Agent session");
      const sessionId =
        cdpSessionId ||
        (clientId && clientId.startsWith("cursor-") ? clientId : undefined);
      const result = await this.cdpManager.sendAgentPrompt(text, sessionId);
      if (!result.ok) {
        throw new Error(result.error || "Failed to send prompt via CDP");
      }
      return;
    }

    // CLI mode (default / fallback)
    if (this.useCLIMode && this.cliHandler) {
      this.log("[Cursor Remote] Using CLI mode for prompt");
      if (execute) {
        await this.cliHandler.sendPrompt(
          text,
          true,
          clientId,
          newSession,
          agentMode,
          senderDeviceId
        );
      } else {
        this.log(
          "[Cursor Remote] Warning: CLI mode does not support non-execute mode, executing anyway"
        );
        await this.cliHandler.sendPrompt(
          text,
          true,
          clientId,
          newSession,
          agentMode,
          senderDeviceId
        );
      }
      return;
    }

    try {
      // Cursor IDE의 채팅 패널 처리
      // workbench.action.chat.open은 새 채팅창을 생성하지만, 텍스트를 입력하려면 채팅 패널이 열려있어야 함
      // 새 채팅창 생성을 허용하고, 텍스트 입력과 자동 실행에 집중

      this.log(
        "[Cursor Remote] Opening chat panel (may create new chat if none exists)"
      );

      // 채팅 패널 열기 (기존 채팅창이 있으면 포커스, 없으면 새로 생성)
      try {
        this.log("[Cursor Remote] Executing workbench.action.chat.open");
        await vscode.commands.executeCommand("workbench.action.chat.open");
        this.log("[Cursor Remote] Chat panel opened");
        // 채팅 패널이 열리거나 포커스될 시간 확보
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch (e) {
        this.logError(`[Cursor Remote] Failed to open chat panel: ${e}`);
        throw new Error("Failed to open the chat panel.");
      }

      // 채팅 입력창에 텍스트를 입력하는 여러 방법 시도
      let textInserted = false;

      // 방법 1: 클립보드 붙여넣기 시도
      try {
        this.log("[Cursor Remote] Attempting clipboard paste");
        await vscode.env.clipboard.writeText(text);
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.CHAT_TEXT_INSERT_DELAY)
        );
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction"
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.CHAT_TEXT_INSERT_DELAY)
        );
        textInserted = true;
        this.log("[Cursor Remote] ✅ Text inserted via clipboard paste");
      } catch (e) {
        this.log(`[Cursor Remote] ❌ Clipboard paste failed: ${e}`);
      }

      // 방법 2: type 명령으로 직접 입력 시도 (붙여넣기가 실패한 경우)
      if (!textInserted) {
        try {
          this.log("[Cursor Remote] Attempting type command");
          // 텍스트를 한 글자씩 입력하는 것처럼 시뮬레이션
          // 하지만 긴 텍스트의 경우 느릴 수 있으므로, 짧은 텍스트만 시도
          if (text.length < 100) {
            await vscode.commands.executeCommand("type", { text: text });
            await new Promise((resolve) =>
              setTimeout(resolve, CONFIG.CHAT_TEXT_INSERT_DELAY)
            );
            textInserted = true;
            this.log("[Cursor Remote] ✅ Text inserted via type command");
          } else {
            // 긴 텍스트는 클립보드 붙여넣기만 사용
            throw new Error("Text too long for type command");
          }
        } catch (e) {
          this.log(`[Cursor Remote] ❌ Type command failed: ${e}`);
        }
      }

      if (!textInserted) {
        this.logError("[Cursor Remote] ❌ Failed to insert text");
        throw new Error("Failed to insert text.");
      }

      // execute 옵션이 true이면 프롬프트 실행 (Enter 키 전송)
      if (execute) {
        this.log("[Cursor Remote] Attempting to execute prompt");
        // 텍스트 입력 후 충분히 대기 (입력이 완료될 시간 확보)
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.CHAT_EXECUTE_DELAY)
        );

        // 채팅 입력창에 포커스를 다시 맞추지 않음 (빈 채팅창 생성 방지)
        // 포커스가 이미 채팅 입력창에 있다고 가정

        let executed = false;

        // 우선순위 1: Cursor IDE의 실제 채팅 제출 명령어 시도
        const executeCommands = [
          // Cursor IDE 특정 명령어들 (가장 우선)
          "cursor.chat.submit",
          "cursor.chat.send",
          "anysphere.chat.submit",
          "anysphere.chat.send",
          // VS Code 일반 명령어들
          "workbench.action.chat.submit",
          "workbench.action.chat.send",
          "workbench.action.chat.acceptInput",
        ];

        for (const cmd of executeCommands) {
          try {
            this.log(`[Cursor Remote] Trying execute command: ${cmd}`);
            await vscode.commands.executeCommand(cmd);
            executed = true;
            this.log(
              `[Cursor Remote] ✅ Successfully executed command: ${cmd}`
            );
            break;
          } catch (e) {
            this.log(`[Cursor Remote] ❌ Command ${cmd} failed: ${e}`);
            continue;
          }
        }

        // 우선순위 2: Enter 키 시뮬레이션 (명령어가 실패한 경우)
        if (!executed) {
          this.log(
            "[Cursor Remote] Commands failed, trying Enter key simulation"
          );
          try {
            // 채팅 입력창에 포커스가 있다고 가정하고 Enter 키 전송
            await vscode.commands.executeCommand("type", { text: "\n" });
            await new Promise((resolve) =>
              setTimeout(resolve, CONFIG.CHAT_TEXT_INSERT_DELAY)
            );
            // 추가로 한 번 더 시도 (일부 경우 두 번 필요할 수 있음)
            await vscode.commands.executeCommand("type", { text: "\n" });
            executed = true;
            this.log("[Cursor Remote] ✅ Enter key simulation completed");
          } catch (e) {
            this.log(`[Cursor Remote] ❌ Enter key simulation failed: ${e}`);
          }
        }

        if (executed) {
          this.log(
            "[Cursor Remote] ✅ Prompt execution attempted successfully"
          );
        } else {
          this.logError(
            "[Cursor Remote] ❌ Could not execute prompt. Tried all available methods."
          );
          this.logError(
            "[Cursor Remote] 💡 Note: The text was inserted but execution failed. You may need to manually press Enter."
          );
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`Error in insertToPrompt: ${errorMsg}`);
      throw new Error(`Failed to insert prompt: ${errorMsg}`);
    }
  }

  private async trySubmitChat(): Promise<boolean> {
    let submitted = false;

    // 방법 1: 채팅 제출 명령어들 시도 (가장 안전한 방법)
    const submitCommands = [
      "workbench.action.chat.acceptInput", // 가장 일반적인 명령어
      "cursor.chat.submit",
      "cursor.chat.send",
      "anysphere.chat.submit",
      "anysphere.chat.send",
      "workbench.action.chat.submit",
      "workbench.action.chat.send",
    ];

    for (const cmd of submitCommands) {
      try {
        this.log(`[Cursor Remote] Trying submit command: ${cmd}`);
        await vscode.commands.executeCommand(cmd);
        await new Promise((resolve) => setTimeout(resolve, 300));
        submitted = true;
        this.log(`[Cursor Remote] ✅ Chat submission successful: ${cmd}`);
        break;
      } catch (e) {
        this.log(`[Cursor Remote] ❌ Command ${cmd} failed: ${e}`);
        continue;
      }
    }

    // 방법 2: 직접 Enter 키 입력 시뮬레이션 (명령어가 실패한 경우만)
    if (!submitted) {
      try {
        this.log("[Cursor Remote] Trying Enter key simulation");
        // 채팅 패널을 다시 열지 않음 (빈 채팅창 생성 방지)
        // Enter 키 시뮬레이션만 시도
        await vscode.commands.executeCommand("type", { text: "\n" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        submitted = true;
        this.log("[Cursor Remote] ✅ Enter key simulation successful");
      } catch (e) {
        this.log(`[Cursor Remote] ⚠️ Enter key simulation failed: ${e}`);
      }
    }

    return submitted;
  }

  async executeCommand(command: string, ...args: any[]): Promise<any> {
    return await vscode.commands.executeCommand(command, ...args);
  }

  async getActiveFile(): Promise<{ path: string; content: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
      return null;
    }

    return {
      path: editor.document.fileName,
      content: editor.document.getText(),
    };
  }

  async saveFile(): Promise<{ success: boolean; path?: string }> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
      throw new Error("No active editor");
    }

    await editor.document.save();
    return {
      success: true,
      path: editor.document.fileName,
    };
  }

  async getAIResponse(): Promise<string> {
    // Cursor AI 응답을 가져오는 로직
    // 실제 구현은 Cursor API에 따라 달라질 수 있음
    // TODO: Cursor AI API 연동
    // 현재는 채팅 히스토리나 최근 AI 응답을 가져오는 방식으로 구현 가능
    return "AI response placeholder - Cursor AI API integration needed";
  }

  /**
   * 클라이언트의 세션 정보 가져오기
   */
  async getSessionInfo(clientId?: string): Promise<any> {
    if (!this.cliHandler) {
      return { currentSessionId: null, clientId: clientId || null };
    }

    // CLIHandler의 clientSessions에 접근하기 위해 타입 캐스팅
    const cliHandlerAny = this.cliHandler as any;
    const clientSessions = cliHandlerAny.clientSessions as
      | Map<string, string>
      | undefined;
    const lastChatId = cliHandlerAny.lastChatId as string | null | undefined;

    if (clientId && clientSessions) {
      const sessionId = clientSessions.get(clientId);
      return {
        clientId: clientId,
        currentSessionId: sessionId || null,
        hasSession: !!sessionId,
      };
    } else {
      return {
        clientId: clientId || null,
        currentSessionId: lastChatId || null,
        hasSession: !!lastChatId,
      };
    }
  }

  /**
   * 대화 히스토리 조회
   */
  async getChatHistory(
    clientId?: string,
    sessionId?: string,
    relaySessionId?: string,
    limit: number = 50
  ): Promise<any> {
    if (!this.cliHandler) {
      return { entries: [] };
    }

    const cliHandlerAny = this.cliHandler as any;
    const getChatHistory = cliHandlerAny.getChatHistory as
      | ((
          clientId?: string,
          sessionId?: string,
          relaySessionId?: string,
          limit?: number
        ) => any[])
      | undefined;

    if (getChatHistory) {
      const entries = getChatHistory.call(
        this.cliHandler,
        clientId,
        sessionId,
        relaySessionId,
        limit
      );
      return { entries };
    }

    return { entries: [] };
  }

  async stopPrompt(): Promise<{ success: boolean }> {
    this.log("[Cursor Remote] stopPrompt called");

    // CLI 모드인 경우 CLI 핸들러 사용
    if (this.useCLIMode && this.cliHandler) {
      this.log("[Cursor Remote] Using CLI mode for stop");
      return await this.cliHandler.stopPrompt();
    }

    try {
      // Cursor IDE의 프롬프트 중지 명령 시도
      const stopCommands = [
        "cursor.chat.stop",
        "cursor.chat.cancel",
        "workbench.action.chat.stop",
        "workbench.action.chat.cancel",
        "workbench.action.interrupt",
        "workbench.action.terminal.interrupt",
      ];

      for (const cmd of stopCommands) {
        try {
          this.log(`[Cursor Remote] Trying stop command: ${cmd}`);
          await vscode.commands.executeCommand(cmd);
          this.log(
            `[Cursor Remote] ✅ Successfully executed stop command: ${cmd}`
          );
          return { success: true };
        } catch (e) {
          this.log(`[Cursor Remote] ❌ Stop command ${cmd} failed: ${e}`);
          continue;
        }
      }

      // 명령이 없으면 Escape 키 시뮬레이션 시도
      try {
        this.log("[Cursor Remote] Trying Escape key simulation");
        // Escape 키를 type 명령으로 시뮬레이션
        await vscode.commands.executeCommand("type", { text: "\u001b" }); // Escape character
        this.log("[Cursor Remote] ✅ Successfully simulated Escape key");
        return { success: true };
      } catch (e) {
        this.log(`[Cursor Remote] ❌ Escape key simulation failed: ${e}`);
      }

      // 마지막 시도: 채팅 패널 닫기
      try {
        this.log("[Cursor Remote] Trying to close active editor as fallback");
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        );
        this.log("[Cursor Remote] ✅ Closed active editor as fallback");
        return { success: true };
      } catch (e) {
        this.logError("[Cursor Remote] ❌ All stop methods failed", e);
        return { success: false };
      }
    } catch (error) {
      this.logError("[Cursor Remote] ❌ Error in stopPrompt", error);
      return { success: false };
    }
  }

  async executeAction(action: string): Promise<{ success: boolean }> {
    try {
      // Cursor IDE의 액션 실행 명령
      // action은 'undo', 'keep', 'accept', 'reject' 등
      const actionCommands = [
        `cursor.chat.${action}`,
        `workbench.action.chat.${action}`,
        `cursor.action.${action}`,
      ];

      for (const cmd of actionCommands) {
        try {
          await vscode.commands.executeCommand(cmd);
          return { success: true };
        } catch (e) {
          continue;
        }
      }

      // 일반적인 액션 명령 시도
      try {
        await vscode.commands.executeCommand(action);
        return { success: true };
      } catch (e) {
        // 액션 버튼 클릭 시뮬레이션
        // Cursor IDE의 UI에서 액션 버튼을 찾아 클릭하는 것은 제한적
        // 대신 키보드 단축키나 명령으로 처리
        return { success: false };
      }
    } catch (error) {
      return { success: false };
    }
  }

  dispose() {
    // CLI 핸들러 정리
    if (this.cliHandler) {
      this.cliHandler.dispose();
      this.cliHandler = null;
    }
  }

  // 터미널 출력을 자동으로 캡처하기 위한 래퍼 스크립트 생성
  // 사용자는 터미널에서 직접 입력하고 출력을 볼 수 있으면서, 동시에 모바일 앱에도 전송됨
  async setupTerminalOutputCapture(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace is open");
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const outputFile = path.join(workspaceRoot, CONFIG.TERMINAL_OUTPUT_FILE);
    const wrapperScript = path.join(
      workspaceRoot,
      ".cursor-remote-gemini-wrapper.sh"
    );

    // 래퍼 스크립트 생성 (tee를 사용하여 터미널과 파일에 동시 출력)
    const scriptContent = `#!/bin/bash
# Cursor Remote Gemini CLI Wrapper
# 터미널에도 출력하고 파일에도 저장하여 모바일 앱으로 전송

OUTPUT_FILE="${outputFile}"
gemini-cli "$@" 2>&1 | tee -a "$OUTPUT_FILE"
`;

    fs.writeFileSync(wrapperScript, scriptContent);
    fs.chmodSync(wrapperScript, 0o755);

    this.log(`[Cursor Remote] Wrapper script created: ${wrapperScript}`);
    this.log(`[Cursor Remote] Output file: ${outputFile}`);

    return wrapperScript;
  }
}
