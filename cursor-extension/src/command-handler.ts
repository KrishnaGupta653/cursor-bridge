import * as vscode from "vscode";
import * as path from "path";
import { CLIHandler } from "./cli-handler";
import { WebSocketServer } from "./websocket-server";
import { CONFIG } from "./config";
import { CdpManager } from "./cdp/cdp-manager";

export class CommandHandler {
  private outputChannel: vscode.OutputChannel | null = null;
  private wsServer: WebSocketServer | null = null;
  private cliHandler: CLIHandler | null = null;
  private cdpManager: CdpManager | null = null;

  constructor(
    outputChannel?: vscode.OutputChannel,
    wsServer?: WebSocketServer,
    storageDir?: string
  ) {
    this.outputChannel = outputChannel || null;
    this.wsServer = wsServer || null;

    // CLI handler always available as fallback
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot =
      workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : undefined;
    this.cliHandler = new CLIHandler(outputChannel, wsServer, workspaceRoot, storageDir);
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

  /** Set the getter used to add relaySessionId to chat history in relay mode */
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

  // Heuristic: does the text look like a shell command?
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
      const workspaceFolders = vscode.workspace.workspaceFolders;
      let outputFile: string | null = null;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        outputFile = path.join(workspaceRoot, CONFIG.TERMINAL_OUTPUT_FILE);
      }

      let terminal = vscode.window.activeTerminal;
      this.log(
        `[Cursor Remote] Active terminal: ${terminal ? terminal.name : "null"}`
      );

      if (!terminal) {
        // No active terminal; create one
        this.log("[Cursor Remote] No active terminal, creating new terminal");
        terminal = vscode.window.createTerminal("Cursor Remote");
        this.log(`[Cursor Remote] Created terminal: ${terminal.name}`);
        terminal.show(true); // true: force focus to the terminal
        this.log(
          "[Cursor Remote] Terminal shown, waiting 800ms for activation..."
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
      } else {
        this.log(`[Cursor Remote] Using existing terminal: ${terminal.name}`);
        terminal.show(true); // true: force focus to the terminal
        this.log(
          "[Cursor Remote] Terminal shown, waiting 500ms for activation..."
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Force terminal focus via VS Code command
      this.log(
        "[Cursor Remote] Executing workbench.action.terminal.focus command..."
      );
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.TERMINAL_FOCUS_DELAY)
      );

      // Check the terminal actually became active
      const activeTerminalAfterWait = vscode.window.activeTerminal;
      if (activeTerminalAfterWait?.name !== terminal.name) {
        this.log(
          `[Cursor Remote] ⚠️ Warning: Terminal may not be active. Expected: ${
            terminal.name
          }, Active: ${activeTerminalAfterWait?.name || "null"}`
        );
        // Continue anyway (there may be multiple terminals)
      } else {
        this.log(`[Cursor Remote] ✅ Terminal is active: ${terminal.name}`);
      }

      // execute=false sends no newline; execute=true simulates Enter
      if (execute) {
        // Extra wait so the terminal has focus
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Auto-capture: redirect output to a file only when the text looks like a command
        let commandToSend = text;
        if (outputFile) {
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

        // Send the text without a newline first;
        // the next sendText call then executes the previous text
        terminal.sendText(commandToSend, false); // false: no newline
        this.log("[Cursor Remote] Text sent, waiting for execution trigger...");

        // After a delay, send a newline to execute the previous text
        // (gives the terminal time to process the text)
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.TERMINAL_EXECUTION_DELAY)
        );
        this.log(`[Cursor Remote] Sending execution trigger (newline)`);
        terminal.sendText("\n", false);
        this.log(
          "[Cursor Remote] ✅ Text sent to terminal with execution (triggered by newline)"
        );
      } else {
        // Send text only (no newline)
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
      if (!cdpSessionId) throw new Error("Explicit CDP sessionId required");
      const result = await this.cdpManager.sendAgentPrompt(
        text,
        sessionId,
        clientId ? { clientId, targetDeviceId: senderDeviceId } : undefined
      );
      if (!result.ok) {
        throw new Error(result.error || "Failed to send prompt via CDP");
      }
      return;
    }

    if (!this.cliHandler) throw new Error("Cursor CLI handler is not available");
    this.log("[Cursor Remote] Using CLI mode for prompt");
    if (!execute) {
      this.log(
        "[Cursor Remote] Warning: CLI mode does not support non-execute mode, executing anyway"
      );
    }
    await this.cliHandler.sendPrompt(
      text,
      true,
      clientId,
      newSession,
      agentMode,
      senderDeviceId
    );
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
    // Fetch the Cursor AI response
    // Actual implementation depends on the Cursor API
    // TODO: integrate Cursor AI API
    // Could be implemented by reading chat history or the latest AI response
    return "AI response placeholder - Cursor AI API integration needed";
  }

  /**
   * Get a client's session info
   */
  async getSessionInfo(clientId?: string): Promise<any> {
    if (!this.cliHandler) {
      return { currentSessionId: null, clientId: clientId || null };
    }

    // Cast to access CLIHandler's clientSessions
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
   * Get chat history
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

    if (!this.cliHandler) return { success: false };
    return await this.cliHandler.stopPrompt();
  }

  async executeAction(action: string): Promise<{ success: boolean }> {
    try {
      // Run a Cursor IDE action command
      // action is e.g. 'undo', 'keep', 'accept', 'reject'
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

      // Try the generic action command
      try {
        await vscode.commands.executeCommand(action);
        return { success: true };
      } catch (e) {
        // Simulating action button clicks in the Cursor UI is limited,
        // so use keyboard shortcuts or commands instead
        return { success: false };
      }
    } catch (error) {
      return { success: false };
    }
  }

  dispose() {
    if (this.cliHandler) {
      this.cliHandler.dispose();
      this.cliHandler = null;
    }
  }
}
