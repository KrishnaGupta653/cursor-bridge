import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";

import { WebSocketServer } from "./websocket-server";
import * as vscode from "vscode";
import { cliHistoryFile, writePrivateFile } from "./private-state";

interface ChatHistoryEntry {
  id: string;
  sessionId: string;
  clientId: string;
  userMessage: string;
  assistantResponse: string;
  timestamp: string;
  agentMode?: string; // Agent mode (agent, ask, plan, debug, auto)
  relaySessionId?: string; // Relay session ID when in relay mode
}

interface ChatHistory {
  entries: ChatHistoryEntry[];
  lastUpdated: string;
}

export const CLI_NOT_INSTALLED = "Cursor CLI (agent) is not installed. Install it from https://cursor.com/cli";

export class CLIHandler {
  private outputChannel: vscode.OutputChannel | null = null;
  private wsServer: WebSocketServer | null = null;
  private currentProcess: child_process.ChildProcess | null = null;
  private preparingPrompt = false;
  private workspaceRoot: string | null = null;
  private processingOutput: boolean = false;
  private lastChatId: string | null = null; // Last chat session ID (for interactive-mode testing)
  private clientSessions: Map<string, string> = new Map(); // Per-client session IDs
  private chatHistoryFile: string | null = null; // Chat history file path
  private pendingHistoryIds: Map<string, string> = new Map(); // clientId -> pending sessionId (replaced with the real sessionId later)
  private streamingBuffers: Map<string, string> = new Map(); // clientId -> stdout buffer (for streaming)
  private lastStreamedText: Map<string, string> = new Map(); // clientId -> last sent text (for dedup)
  private lastPromptByClient: Map<string, string> = new Map(); // clientId -> last executed prompt (to suppress IME duplicates)
  private currentSenderDeviceId: string | null = null; // For unicast replies: ID of the mobile device that sent the current request
  private getRelaySessionId: (() => string | null) | null = null; // Relay session ID getter (used when saving)

  constructor(
    outputChannel?: vscode.OutputChannel,
    wsServer?: WebSocketServer,
    workspaceRoot?: string,
    storageDir?: string
  ) {
    this.outputChannel = outputChannel || null;
    this.wsServer = wsServer || null;
    this.workspaceRoot = workspaceRoot || null;

    // Chat history file path (skip if no workspace or root is / — avoids ENOENT when testing with F5)
    const safeWorkspaceRoot =
      workspaceRoot && workspaceRoot !== "/" && workspaceRoot.length > 1;
    if (safeWorkspaceRoot && storageDir) {
      this.chatHistoryFile = cliHistoryFile(storageDir, workspaceRoot);
    }
  }

  /** Set the getter used to add relaySessionId to saved history in relay mode */
  setGetRelaySessionId(getter: () => string | null): void {
    this.getRelaySessionId = getter;
  }

  private log(message: string, sendToClient: boolean = false) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [CLI] ${message}`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.log(logMessage);

    // Diagnostic logs stay local; protocol events require an explicit recipient.
  }

  private logError(message: string, _error?: unknown, _sendToClient = false) {
    this.log(`ERROR: ${message}`);
  }

  /**
   * Check whether the Cursor CLI is installed
   */
  private async checkCLIInstalled(): Promise<boolean> {
    return new Promise(async (resolve) => {
      // Look in PATH
      child_process.exec("which agent", (error) => {
        if (!error) {
          resolve(true);
          return;
        }

        child_process.exec("which cursor-agent", (error2) => {
          if (!error2) {
            resolve(true);
            return;
          }

          // Check common install locations
          const os = require("os");
          const homeDir = os.homedir();
          const commonPaths = [
            path.join(homeDir, ".local", "bin", "agent"),
            path.join(homeDir, ".local", "bin", "cursor-agent"),
            path.join(
              homeDir,
              "Library",
              "Application Support",
              "Cursor",
              "bin",
              "agent"
            ),
            path.join(
              homeDir,
              "Library",
              "Application Support",
              "Cursor",
              "bin",
              "cursor-agent"
            ),
          ];

          const exists = commonPaths.some((cliPath) => fs.existsSync(cliPath));
          resolve(exists);
        });
      });
    });
  }

  /**
   * Find the Cursor CLI command path
   */
  private async findCLICommand(): Promise<string> {
    return new Promise((resolve) => {
      // 1. 'agent' in PATH
      child_process.exec("which agent", (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim());
          return;
        }

        // 2. 'cursor-agent' in PATH
        child_process.exec("which cursor-agent", (error2, stdout2) => {
          if (!error2 && stdout2.trim()) {
            resolve(stdout2.trim());
            return;
          }

          // 3. Common install locations
          const os = require("os");
          const homeDir = os.homedir();
          const commonPaths = [
            path.join(homeDir, ".local", "bin", "agent"),
            path.join(homeDir, ".local", "bin", "cursor-agent"),
            path.join(
              homeDir,
              "Library",
              "Application Support",
              "Cursor",
              "bin",
              "agent"
            ),
            path.join(
              homeDir,
              "Library",
              "Application Support",
              "Cursor",
              "bin",
              "cursor-agent"
            ),
          ];

          let found = false;
          for (const cliPath of commonPaths) {
            if (fs.existsSync(cliPath)) {
              resolve(cliPath);
              found = true;
              break;
            }
          }

          // 4. Not found: fall back to the default (assume it's in PATH)
          if (!found) {
            resolve("agent");
          }
        });
      });
    });
  }

  /**
   * Send a prompt to the Cursor CLI
   * @param text Prompt text
   * @param execute Whether to execute
   * @param clientId Client ID (for session isolation, optional)
   * @param newSession Whether to start a new session (decided by the client, default: false)
   * @param agentMode Agent mode (agent, ask, plan, debug, auto)
   * @param senderDeviceId In relay mode, ID of the mobile device that sent the request (for unicast replies)
   */
  async sendPrompt(...args: Parameters<CLIHandler["sendPromptInternal"]>): Promise<void> {
    if (this.preparingPrompt || this.currentProcess) {
      throw new Error("CLI is busy; wait for the current run to finish");
    }
    this.preparingPrompt = true;
    try { await this.sendPromptInternal(...args); }
    finally { this.preparingPrompt = false; }
  }

  private async sendPromptInternal(
    text: string,
    execute: boolean = true,
    clientId?: string,
    newSession: boolean = false,
    agentMode: "agent" | "ask" | "plan" | "debug" | "auto" = "auto",
    senderDeviceId?: string
  ): Promise<void> {
    // Remember the device ID for unicast replies
    this.currentSenderDeviceId = senderDeviceId || null;

    this.log(
      `sendPrompt called - textLength: ${
        text.length
      }, execute: ${execute}, clientId: ${
        clientId || "none"
      }, newSession: ${newSession}, senderDeviceId: ${senderDeviceId || "none"}`
    );

    // Ignore duplicate single-character IME input: if a process is already running, the new prompt is
    // one character, and the last prompt ends with it, ignore it (keeps the relay-mode reply intact)
    if (this.currentProcess && text.length === 1) {
      const key = clientId || "global";
      const lastPrompt = this.lastPromptByClient.get(key);
      if (lastPrompt && lastPrompt.endsWith(text)) {
        this.log(
          `Skipping IME duplicate single character "${text}" to preserve ongoing response`
        );
        return;
      }
    }

    // Agent mode (used for history and CLI execution)
    let selectedMode: string = "agent"; // default
    if (agentMode && agentMode !== "auto") {
      selectedMode = agentMode;
    } else if (agentMode === "auto") {
      // Auto mode: pick a mode based on the text
      const autoMode = this.detectAgentMode(text);
      selectedMode = autoMode || "agent"; // default: Agent mode
    }

    // Save the user message to chat history.
    // The session ID may only arrive with the response, so use a temporary ID for now.
    // Note: newSession=true ignores the existing session, so history starts fresh too.
    if (clientId) {
      const currentSessionId = newSession
        ? null
        : this.clientSessions.get(clientId) || null;
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .substring(7)}`; // unique temporary ID
      this.log(
        `💾 Saving user message - sessionId: ${
          currentSessionId || pendingId
        }, clientId: ${clientId}, newSession: ${newSession}, agentMode: ${selectedMode}`
      );
      this.log(
        `💾 sendPrompt agentMode param: ${agentMode}, selectedMode: ${selectedMode}`
      );
      this.saveChatHistoryEntry({
        sessionId: currentSessionId || pendingId,
        clientId: clientId,
        userMessage: text,
        timestamp: new Date().toISOString(),
        agentMode: selectedMode,
      });
      // Remember the pending ID so it can be replaced with the real sessionId later
      if (!currentSessionId) {
        this.pendingHistoryIds.set(clientId, pendingId);
        this.log(
          `💾 Saved pending history ID: ${pendingId} for client ${clientId}`
        );
      }
    }

    try {
      // Check the CLI is installed
      const isInstalled = await this.checkCLIInstalled();
      if (!isInstalled) {
        throw new Error(CLI_NOT_INSTALLED);
      }

      const cliCommand = await this.findCLICommand();
      this.log(`Using CLI command: ${cliCommand}`);

      // Run the Cursor CLI.
      // Use --output-format stream-json and --stream-partial-output for streaming
      // Keep CLI permission checks enabled.
      const args: string[] = [];

      // The client decides whether to start a new session
      if (newSession) {
        // Client explicitly requested a new session
        this.log(
          `Starting new session (client requested) for client ${
            clientId || "global"
          }`
        );
      } else {
        // Try to resume the existing session
        let sessionId: string | null = null;
        if (clientId) {
          sessionId = this.clientSessions.get(clientId) || null;
        } else {
          // No clientId: use the global session (backward compat)
          sessionId = this.lastChatId;
        }

        if (sessionId) {
          args.push("--resume", sessionId);
          this.log(
            `Resuming chat session for client ${
              clientId || "global"
            }: ${sessionId}`
          );
        } else {
          // No session: start a new one
          this.log(
            `Starting new chat session for client ${
              clientId || "global"
            } (no existing session)`
          );
        }
      }

      // Only plan/ask are passed to the CLI. debug isn't supported by the CLI, so it runs as agent (no flag)
      const cliMode = selectedMode === "debug" ? "agent" : selectedMode;
      const cliAllowedModes = ["plan", "ask"];
      if (cliMode && cliAllowedModes.includes(cliMode)) {
        args.push("--mode", cliMode);
        this.log(`Using agent mode for CLI: ${cliMode}`);
      } else {
        this.log(
          `CLI: no --mode (display mode=${selectedMode}, cliMode=${cliMode})`
        );
      }

      // Log the chosen mode (selectedMode is kept for display)
      const modeDisplayName = this.getModeDisplayName(selectedMode);
      this.log(`🤖 Agent Mode: ${modeDisplayName} (${selectedMode})`, true);

      // If auto mode chose the mode, send the actual mode to the mobile app
      if (agentMode === "auto" && this.wsServer) {
        this.wsServer.send(
          JSON.stringify({
            type: "agent_mode_selected",
            clientId,
            targetDeviceId: senderDeviceId,
            requestedMode: "auto",
            actualMode: selectedMode,
            displayName: modeDisplayName,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // Streaming: stream-json format with partial output
      // -p: non-interactive mode (used with --stream-partial-output)
      // --output-format stream-json: streaming JSON format
      // --stream-partial-output: stream partial output
      args.push(
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--",
        text
      );

      this.log(`Executing CLI command...`, true);

      // Working directory
      const cwd = this.workspaceRoot || process.cwd();

      // Environment variables to minimise stdout buffering
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: "1", // Disable Python buffering (in case it's used)
        NODE_NO_WARNINGS: "1",
      };

      this.currentProcess = child_process.spawn(cliCommand, args, {
        cwd: cwd,
        stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
        shell: false,
        env: env,
      });

      this.log(`CLI process started`, true);
      this.log(
        `CLI process stdout: ${this.currentProcess.stdout ? "exists" : "null"}`
      );
      this.log(
        `CLI process stderr: ${this.currentProcess.stderr ? "exists" : "null"}`
      );

      let stdout = "";
      let stderr = "";
      let stdoutEnded = false;
      let stderrEnded = false;

      // Capture this prompt's clientId in the closure (used by checkAndProcessOutput)
      const currentClientId = clientId;

      // Remember this prompt for IME duplicate detection
      this.lastPromptByClient.set(clientId || "global", text);

      // Debug: log whether clientId is passed through
      if (clientId) {
        this.log(`🔑 Using clientId: ${clientId} for this prompt`);
        const existingSession = this.clientSessions.get(clientId);
        if (existingSession) {
          this.log(
            `🔑 Found existing session for client ${clientId}: ${existingSession}`
          );
        } else {
          this.log(
            `🔑 No existing session for client ${clientId}, will create new session`
          );
        }
      } else {
        this.log(
          `⚠️ No clientId provided, using global session (lastChatId: ${
            this.lastChatId || "none"
          })`
        );
      }

      // Collect stdout and stream in real time
      if (this.currentProcess.stdout) {
        // Minimise buffering so data flushes immediately
        this.currentProcess.stdout.setEncoding("utf8");

        // Reset the streaming buffer
        if (currentClientId) {
          this.streamingBuffers.set(currentClientId, "");
          this.lastStreamedText.set(currentClientId, "");
        }

        this.currentProcess.stdout.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stdout += chunk;
          this.log(`CLI stdout chunk (${chunk.length} characters)`);
          // Chunk sending disabled: both local and relay use only the final chat_response
        });

        this.currentProcess.stdout.on("end", () => {
          this.log("CLI stdout stream ended");
          stdoutEnded = true;


        });

        this.currentProcess.stdout.on("error", (error) => {
          this.logError("CLI stdout stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stdout is null");
      }

      // Collect stderr
      if (this.currentProcess.stderr) {
        // Disable buffering (if possible)
        this.currentProcess.stderr.setEncoding("utf8");

        this.currentProcess.stderr.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stderr += chunk;
          this.log(`CLI stderr chunk (${chunk.length} characters)`);
        });

        this.currentProcess.stderr.on("end", () => {
          this.log("CLI stderr stream ended");
          stderrEnded = true;
        });

        this.currentProcess.stderr.on("error", (error) => {
          this.logError("CLI stderr stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stderr is null");
      }

      let processFailed = false;
      this.currentProcess.on("error", () => {
        processFailed = true;
        this.logError("CLI process spawn failed");
        this.sendOutputError(currentClientId, "CLI_SPAWN_FAILED", "The CLI could not start.");
      });

      // Handle process exit
      this.currentProcess.on("close", (code, signal) => {
        this.log(
          `CLI process exited with code ${code}, signal: ${signal || "none"}`
        );
        this.log(
          `Final stdout length: ${stdout.length}, stderr length: ${stderr.length}`
        );
        this.log(`stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);


        if (stdout.length === 0 && stderr.length === 0) {
          this.logError("⚠️ No output received from CLI process");
          this.logError(
            "⚠️ This might indicate the process was killed or did not produce output"
          );
        }

        // The process has exited, so process the output (once),
        // even if the streams haven't ended yet
        if (!processFailed) {
          if (code !== 0) {
            this.sendOutputError(currentClientId, "CLI_EXECUTION_FAILED", "The CLI did not complete successfully.");
          } else {
            this.checkAndProcessOutput(stdout, stderr, currentClientId);
          }
        }
        if (currentClientId) {
          this.streamingBuffers.delete(currentClientId);
          this.lastStreamedText.delete(currentClientId);
        }
        this.currentSenderDeviceId = null;
        this.currentProcess = null;
      });

    } catch (error) {
      // Only the install hint is safe and useful to show remotely; everything else stays generic.
      const notInstalled = error instanceof Error && error.message === CLI_NOT_INSTALLED;
      this.logError(notInstalled ? CLI_NOT_INSTALLED : "CLI prompt failed");
      throw new Error(notInstalled ? CLI_NOT_INSTALLED : "Failed to send CLI prompt");
    }
  }

  /**
   * Process CLI output and send it over WebSocket
   * @param clientId Client ID (for session isolation, optional)
   */
  private sendOutputError(clientId: string | undefined, code: string, message: string): void {
    if (!clientId || !this.wsServer) return;
    this.wsServer.send(JSON.stringify({
      type: "error", code, message, clientId, source: "cli",
      targetDeviceId: this.currentSenderDeviceId || undefined,
      timestamp: new Date().toISOString(),
    }));
  }

  private checkAndProcessOutput(
    stdout: string,
    stderr: string,
    clientId?: string
  ) {
    // Prevent duplicate processing
    if (this.processingOutput) {
      this.log(
        "⚠️ Output processing already in progress, skipping duplicate call"
      );
      return;
    }
    this.processingOutput = true;

    this.log(
      `Processing output - stdout length: ${stdout.length}, stderr length: ${stderr.length}`
    );

    // Plain text output (no JSON format; for streaming)
    try {

      // stream-json may contain multiple JSON lines;
      // parse each line to extract the final result-type entry
      let responseText = "";
      let extractedSessionId: string | null = null;
      let structuredOutput = false;

      // Parse each line looking for the result type
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line.trim());
          structuredOutput = true;

          // Extract session_id
          const sessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (sessionId && !extractedSessionId) {
            extractedSessionId = sessionId;
          }

          // result type: final result
          if (jsonData.type === "result" && jsonData.result) {
            if (typeof jsonData.result === "string") {
              responseText = jsonData.result;
            }
          }
          // assistant type: ignored, streaming already finished
          // (already sent if streaming worked)
        } catch (e) {
          // Ignore lines that fail to parse as JSON
          continue;
        }
      }

      // No result type found: use the streamed text
      if (!responseText && clientId) {
        responseText = this.lastStreamedText.get(clientId) || "";
      }

      // Still nothing: use the whole stdout (backward compat)
      if (!responseText && !structuredOutput) {
        responseText = stdout.trim();
      }
      if (!responseText) {
        this.sendOutputError(clientId, "CLI_NO_RESULT", "The CLI returned no result.");
        return;
      }

      // Save session_id (if extracted from JSON)
      if (extractedSessionId) {
        if (clientId) {
          this.clientSessions.set(clientId, extractedSessionId);
          this.log(
            `💾 Saved session ID for client ${clientId}: ${extractedSessionId}`
          );
        } else {
          this.lastChatId = extractedSessionId;
          this.log(`💾 Saved global session ID: ${extractedSessionId}`);
        }
      }

      this.log(`Extracted response text length: ${responseText.length}`);
      // Save the response to chat history
      const currentSessionId =
        extractedSessionId ||
        (clientId ? this.clientSessions.get(clientId) : this.lastChatId);
      if (clientId) {
        // Use sessionId if present, otherwise the pending ID
        const sessionIdToUse =
          currentSessionId || this.pendingHistoryIds.get(clientId) || "unknown";
        this.log(
          `💾 Saving assistant response - sessionId: ${sessionIdToUse}, clientId: ${clientId}, hasPendingId: ${this.pendingHistoryIds.has(
            clientId
          )}`
        );
        this.saveChatHistoryEntry({
          sessionId: sessionIdToUse,
          clientId: clientId,
          assistantResponse: responseText,
          timestamp: new Date().toISOString(),
        });

        // Had a pending ID and got the real sessionId: update it
        if (extractedSessionId && this.pendingHistoryIds.has(clientId)) {
          const pendingId = this.pendingHistoryIds.get(clientId)!;
          this.log(
            `💾 Updating pending sessionId ${pendingId} to ${extractedSessionId}`
          );
          this.updatePendingSessionId(clientId, pendingId, extractedSessionId);
          this.pendingHistoryIds.delete(clientId);
        }
      }

      // Send the final response over WebSocket.
      // Relay mode doesn't send chat_response_chunk, so the final chat_response must always be sent.
      // For local-only use, sending the final message after streaming lets the app overwrite/finalise.
      if (this.wsServer && responseText) {
        const responseMessage = {
          type: "chat_response",
          text: responseText,
          timestamp: new Date().toISOString(),
          source: "cli",
          sessionId: currentSessionId || undefined,
          clientId: clientId || undefined,
          targetDeviceId: this.currentSenderDeviceId || undefined, // for unicast replies
        };

        this.log(`Sending chat_response (${responseText.length} characters)`);
        if (currentSessionId) {
          this.log(
            `   Session ID: ${currentSessionId}, Client ID: ${
              clientId || "none"
            }`
          );
        }
        if (clientId === "relay-client") {
          this.log(
            `📤 Relay mode: sending chat_response (${responseText.length} chars) to wsServer`
          );
        }
        this.wsServer.send(JSON.stringify(responseMessage));
        this.log("✅ AI response received", true);
      } else if (this.wsServer && !responseText) {
        this.logError(
          "wsServer is null or responseText is empty (no stdout/stderr to send)"
        );
      }
    } catch (error) {
      this.logError("Output processing failed");
      this.sendOutputError(clientId, "CLI_OUTPUT_INVALID", "The CLI result could not be processed.");
    } finally {
      this.processingOutput = false;
      this.currentSenderDeviceId = null; // Reset after the response completes
    }
  }

  /**
   * Handle real-time streaming chunks.
   * stream-json format: each delta is emitted as JSON
   * - thinking: internal reasoning (not streamed)
   * - assistant: actual response text (streamed)
   * - result: final result (used when streaming completes)
   */
  private processStreamingChunk(buffer: string, clientId: string) {
    // Chunk sending disabled: both local and relay use only the final chat_response
    return;
    try {
      // In stream-json each line may be a JSON delta;
      // split the buffer into lines and process each delta
      const lines = buffer.split("\n").filter((line) => line.trim().length > 0);

      let accumulatedText = this.lastStreamedText.get(clientId) || "";
      let hasNewData = false;

      for (const line of lines) {
        try {
          // Try to parse the JSON delta
          const jsonData = JSON.parse(line.trim());

          // Extract session_id (if present)
          const extractedSessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (extractedSessionId && clientId) {
            this.clientSessions.set(clientId, extractedSessionId);
          }

          // Handle by type
          const messageType = jsonData.type;

          if (messageType === "assistant") {
            // assistant: extract the response text
            const message = jsonData.message;
            if (message && message.content && Array.isArray(message.content)) {
              for (const content of message.content) {
                if (content.type === "text" && content.text) {
                  const text = content.text;
                  // Compare with the previous text and append only the new part
                  if (
                    text.length > accumulatedText.length &&
                    text.startsWith(accumulatedText)
                  ) {
                    // New text starts with the previous text (the usual case)
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (
                    accumulatedText.length > 0 &&
                    text.startsWith(accumulatedText) &&
                    text.length >= accumulatedText.length
                  ) {
                    // Starts with the previous text but is the same length or longer
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (text !== accumulatedText && text.length > 0) {
                    // Text changed completely, or this is the first chunk
                    accumulatedText = text;
                    hasNewData = true;
                  }
                }
              }
            }
          } else if (messageType === "result" && jsonData.result) {
            // result: final result (replace with the full text)
            const resultText = jsonData.result;
            if (typeof resultText === "string" && resultText.length > 0) {
              accumulatedText = resultText;
              hasNewData = true;
            }
          }
          // Ignore thinking (internal reasoning)
          // and system/user types
        } catch (parseError) {
          // Ignore non-JSON lines (every stream-json line should be JSON);
          // plain text output isn't supported for backward compat
        }
      }

      // Send if there is new data
      if (hasNewData && this.wsServer) {
        const lastText = this.lastStreamedText.get(clientId) || "";

        // Send when accumulatedText differs from lastText
        if (accumulatedText !== lastText) {
          const newText =
            accumulatedText.length > lastText.length
              ? accumulatedText.substring(lastText.length)
              : accumulatedText; // first chunk: send the full text

          if (newText.length > 0 || accumulatedText.length > 0) {
            const currentSessionId =
              this.clientSessions.get(clientId) || undefined;

            const chunkMessage = {
              type: "chat_response_chunk",
              text: newText.length > 0 ? newText : accumulatedText, // use the full text if newText is empty
              fullText: accumulatedText,
              timestamp: new Date().toISOString(),
              source: "cli",
              sessionId: currentSessionId || undefined,
              clientId: clientId,
              isReplace: newText.length === 0, // first chunk or full replacement
            };

            this.wsServer?.send(JSON.stringify(chunkMessage));
            this.lastStreamedText.set(clientId, accumulatedText);
            this.log(
              `📤 Streaming chunk sent (${
                newText.length > 0 ? newText.length : accumulatedText.length
              } chars, total: ${accumulatedText.length})`
            );
          }
        }
      }
    } catch (error) {
      // On error, log and continue
      this.logError("Error processing streaming chunk", error);
    }
  }

  /**
   * Stop the running CLI process
   */
  async stopPrompt(): Promise<{ success: boolean }> {
    this.log("stopPrompt called");

    if (this.currentProcess) {
      try {
        this.currentProcess.kill("SIGINT");
        this.currentProcess = null;
        this.log("CLI process stopped");
        return { success: true };
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        this.logError("Stopping CLI failed");
        return { success: false };
      }
    }

    return { success: true };
  }

  /**
   * Dispose the CLI handler
   */
  dispose() {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  /**
   * Save chat history
   */
  private saveChatHistoryEntry(
    entry: Partial<ChatHistoryEntry> & { clientId: string; timestamp: string }
  ): void {
    if (!this.chatHistoryFile) {
      return;
    }

    try {
      let history: ChatHistory = {
        entries: [],
        lastUpdated: new Date().toISOString(),
      };

      // Load existing history
      if (fs.existsSync(this.chatHistoryFile)) {
        const content = fs.readFileSync(this.chatHistoryFile, "utf8");
        try {
          const parsed = JSON.parse(content);
          // Convert the legacy (array) format to the new format
          if (Array.isArray(parsed)) {
            this.log("🔄 Converting old chat history format to new format");
            history = {
              entries: parsed.map((oldEntry: any, index: number) => ({
                id: `${Date.now()}-${index}-${Math.random()
                  .toString(36)
                  .substring(7)}`,
                sessionId: "unknown",
                clientId: "legacy",
                userMessage: oldEntry.user || oldEntry.userMessage || "",
                assistantResponse:
                  oldEntry.assistant || oldEntry.assistantResponse || "",
                timestamp: oldEntry.timestamp || new Date().toISOString(),
              })),
              lastUpdated: new Date().toISOString(),
            };
          } else if (parsed.entries && Array.isArray(parsed.entries)) {
            // New format
            history = parsed;
          } else {
            // Unknown format
            this.log("⚠️ Unknown chat history format, resetting");
            history = { entries: [], lastUpdated: new Date().toISOString() };
          }
          // Make sure entries is an array
          if (!Array.isArray(history.entries)) {
            this.log("⚠️ history.entries is not an array, resetting");
            history.entries = [];
          }
        } catch (e) {
          this.logError("Failed to parse chat history", e);
          history = { entries: [], lastUpdated: new Date().toISOString() };
        }
      }

      // Create the new entry
      const newEntry: ChatHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        sessionId: entry.sessionId || "unknown",
        clientId: entry.clientId,
        userMessage: entry.userMessage || "",
        assistantResponse: entry.assistantResponse || "",
        timestamp: entry.timestamp,
        agentMode: entry.agentMode,
      };
      // In relay mode, also store the relay session ID
      if (entry.clientId === "relay-client" && this.getRelaySessionId) {
        const rid = this.getRelaySessionId();
        if (rid) newEntry.relaySessionId = rid;
      }

      // Replace the pending sessionId with the real sessionId
      if (newEntry.sessionId.startsWith("pending-") && entry.clientId) {
        const actualSessionId = this.clientSessions.get(entry.clientId);
        if (actualSessionId) {
          newEntry.sessionId = actualSessionId;
          // Remove the pending ID
          this.pendingHistoryIds.delete(entry.clientId);
        }
      }

      // Find the latest entry (same clientId with a user message and no response),
      // or one whose pending ID is being replaced with the real sessionId
      let lastEntry: ChatHistoryEntry | undefined = undefined;
      let lastEntryIndex = -1;

      // Search backwards for the most recent entry
      for (let i = history.entries.length - 1; i >= 0; i--) {
        const entry = history.entries[i];
        if (entry.clientId === newEntry.clientId) {
          const timeDiff = Math.abs(
            new Date(entry.timestamp).getTime() -
              new Date(newEntry.timestamp).getTime()
          );
          // Has a user message but no response (the response needs adding)
          if (
            entry.userMessage &&
            !entry.assistantResponse &&
            timeDiff < 30000
          ) {
            this.log(
              `💾 Found entry to update with response - entryId: ${
                entry.id
              }, hasAgentMode: ${!!entry.agentMode}`
            );
            lastEntry = entry;
            lastEntryIndex = i;
            break;
          }
          // Pending ID being replaced with the real sessionId
          if (
            entry.sessionId.startsWith("pending-") &&
            !newEntry.sessionId.startsWith("pending-") &&
            timeDiff < 30000
          ) {
            this.log(
              `💾 Found entry to update sessionId - entryId: ${
                entry.id
              }, hasAgentMode: ${!!entry.agentMode}`
            );
            lastEntry = entry;
            lastEntryIndex = i;
            break;
          }
          // Same sessionId (updating an already complete entry)
          if (entry.sessionId === newEntry.sessionId && timeDiff < 30000) {
            this.log(
              `💾 Found entry with same sessionId - entryId: ${
                entry.id
              }, hasAgentMode: ${!!entry.agentMode}`
            );
            lastEntry = entry;
            lastEntryIndex = i;
            break;
          }
        }
      }

      if (lastEntry) {
        // Update the existing entry
        this.log(
          `💾 Updating existing entry - id: ${
            lastEntry.id
          }, currentAgentMode: ${lastEntry.agentMode || "undefined"}`
        );
        if (newEntry.userMessage) {
          lastEntry.userMessage = newEntry.userMessage;
        }
        if (newEntry.assistantResponse) {
          lastEntry.assistantResponse = newEntry.assistantResponse;
        }
        // Update agentMode only when there is a user message and agentMode was provided,
        // so saving just the response doesn't overwrite it
        if (newEntry.userMessage && newEntry.agentMode) {
          lastEntry.agentMode = newEntry.agentMode;
          this.log(`💾 Updated agentMode for entry: ${newEntry.agentMode}`);
        } else if (newEntry.userMessage && !newEntry.agentMode) {
          this.log(
            `⚠️ User message saved but agentMode is missing - keeping existing: ${
              lastEntry.agentMode || "undefined"
            }`
          );
        } else if (newEntry.assistantResponse && !newEntry.userMessage) {
          // Saving only the response: keep the existing agentMode
          this.log(
            `💾 Saving response only - preserving agentMode: ${
              lastEntry.agentMode || "undefined"
            }`
          );
        }
        // Also update sessionId (pending -> actual)
        if (
          lastEntry.sessionId.startsWith("pending-") &&
          !newEntry.sessionId.startsWith("pending-")
        ) {
          lastEntry.sessionId = newEntry.sessionId;
        }
        // Update the relay session ID (when saving a relay-mode response)
        if (newEntry.relaySessionId) {
          lastEntry.relaySessionId = newEntry.relaySessionId;
        }
        // Update the timestamp
        lastEntry.timestamp = newEntry.timestamp;
        this.log(
          `💾 Entry updated - final agentMode: ${
            lastEntry.agentMode || "undefined"
          }`
        );
      } else {
        // Add a new entry
        history.entries.push(newEntry);
      }

      // Keep at most 100 entries
      if (history.entries.length > 100) {
        history.entries = history.entries.slice(-100);
      }

      history.lastUpdated = new Date().toISOString();

      // Write the file
      if (!writePrivateFile(this.chatHistoryFile, JSON.stringify(history, null, 2))) {
        throw new Error(`Could not write ${this.chatHistoryFile}`);
      }
      this.log(`💾 Chat history saved (${history.entries.length} entries)`);
    } catch (error) {
      this.logError("Failed to save chat history", error);
    }
  }

  /**
   * Replace a pending sessionId with the real sessionId
   */
  private updatePendingSessionId(
    clientId: string,
    pendingId: string,
    actualSessionId: string
  ): void {
    if (!this.chatHistoryFile || !fs.existsSync(this.chatHistoryFile)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.chatHistoryFile, "utf8");
      const parsed = JSON.parse(content);

      // Convert the legacy (array) format to the new format
      let history: ChatHistory;
      if (Array.isArray(parsed)) {
        history = {
          entries: parsed.map((oldEntry: any, index: number) => ({
            id: `${Date.now()}-${index}-${Math.random()
              .toString(36)
              .substring(7)}`,
            sessionId: "unknown",
            clientId: "legacy",
            userMessage: oldEntry.user || oldEntry.userMessage || "",
            assistantResponse:
              oldEntry.assistant || oldEntry.assistantResponse || "",
            timestamp: oldEntry.timestamp || new Date().toISOString(),
          })),
          lastUpdated: new Date().toISOString(),
        };
      } else if (parsed.entries && Array.isArray(parsed.entries)) {
        history = parsed;
      } else {
        this.log("⚠️ Unknown chat history format in updatePendingSessionId");
        return;
      }

      // Make sure entries is an array
      if (!Array.isArray(history.entries)) {
        this.log(
          "⚠️ history.entries is not an array in updatePendingSessionId"
        );
        return;
      }

      // Find the entry with the pending ID and replace it with the real sessionId
      history.entries.forEach((entry) => {
        if (entry.clientId === clientId && entry.sessionId === pendingId) {
          entry.sessionId = actualSessionId;
        }
      });

      fs.writeFileSync(
        this.chatHistoryFile,
        JSON.stringify(history, null, 2),
        "utf8"
      );
      this.log(
        `💾 Updated pending sessionId ${pendingId} to ${actualSessionId} in history`
      );
    } catch (error) {
      this.logError("Failed to update pending sessionId", error);
    }
  }

  /**
   * Get chat history
   */
  getChatHistory(
    clientId?: string,
    sessionId?: string,
    relaySessionId?: string,
    limit: number = 50
  ): ChatHistoryEntry[] {
    if (!this.chatHistoryFile || !fs.existsSync(this.chatHistoryFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.chatHistoryFile, "utf8");
      const parsed = JSON.parse(content);

      // Convert the legacy (array) format to the new format
      let history: ChatHistory;
      if (Array.isArray(parsed)) {
        history = {
          entries: parsed.map((oldEntry: any, index: number) => ({
            id: `${Date.now()}-${index}-${Math.random()
              .toString(36)
              .substring(7)}`,
            sessionId: "unknown",
            clientId: "legacy",
            userMessage: oldEntry.user || oldEntry.userMessage || "",
            assistantResponse:
              oldEntry.assistant || oldEntry.assistantResponse || "",
            timestamp: oldEntry.timestamp || new Date().toISOString(),
            agentMode: oldEntry.agentMode, // include agentMode from legacy data too
          })),
          lastUpdated: new Date().toISOString(),
        };
      } else if (parsed.entries && Array.isArray(parsed.entries)) {
        history = parsed;
      } else {
        this.log("⚠️ Unknown chat history format in getChatHistory");
        return [];
      }

      // Make sure entries is an array
      if (!Array.isArray(history.entries)) {
        this.log("⚠️ history.entries is not an array in getChatHistory");
        return [];
      }

      let filtered = history.entries;

      // Filter by client ID (only if clientId is provided)
      if (clientId) {
        filtered = filtered.filter((entry) => entry.clientId === clientId);
      }
      // No clientId: return all history (for recent-history lookups)

      // Filter by session ID (Cursor CLI chat thread ID)
      if (sessionId) {
        filtered = filtered.filter((entry) => entry.sessionId === sessionId);
      }
      // Filter by relay session ID (only the current session in relay mode)
      if (relaySessionId) {
        filtered = filtered.filter(
          (entry) =>
            (entry as ChatHistoryEntry).relaySessionId === relaySessionId
        );
      }

      // Sort newest first and apply the limit
      filtered.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      return filtered.slice(0, limit);
    } catch (error) {
      this.logError("Failed to load chat history", error);
      return [];
    }
  }

  /**
   * Pick an agent mode automatically based on the text
   */
  private detectAgentMode(
    text: string
  ): "agent" | "ask" | "plan" | "debug" | null {
    const lowerText = text.toLowerCase();

    // Debug mode keywords
    const debugKeywords = [
      "bug",
      "error",
      "fix",
      "debug",
      "issue",
      "problem",
      "crash",
      "exception",
      "trace",
      "log",
    ];
    if (debugKeywords.some((keyword) => lowerText.includes(keyword))) {
      // Bug-related keyword found; check whether it's just a question
      if (
        lowerText.includes("why") ||
        lowerText.includes("what") ||
        lowerText.includes("how") ||
        lowerText.includes("?")
      ) {
        // Phrased as a question: Ask mode
        if (
          lowerText.includes("explain") ||
          lowerText.includes("understand") ||
          lowerText.includes("learn")
        ) {
          return "ask";
        }
      }
      return "debug";
    }

    // Plan mode keywords
    const planKeywords = [
      "plan",
      "design",
      "architecture",
      "implement",
      "create",
      "build",
      "feature",
      "refactor",
      "analyze",
      "analysis",
      "project",
      "review",
      "overview",
      "structure",
    ];
    if (planKeywords.some((keyword) => lowerText.includes(keyword))) {
      // Complex-task keywords (Korean: "whole", "all", "overall")
      const complexKeywords = [
        "multiple",
        "several",
        "many",
        "system",
        "module",
        "component",
        "project",
        "\uC804\uCCB4",
        "\uBAA8\uB4E0",
        "\uC804\uBC18",
      ];
      if (complexKeywords.some((keyword) => lowerText.includes(keyword))) {
        return "plan";
      }
      // Patterns like "analyse the project" are also Plan mode (Korean: "analysis")
      if (
        lowerText.includes("analyze") ||
        lowerText.includes("analysis") ||
        lowerText.includes("\uBD84\uC11D")
      ) {
        return "plan";
      }
    }

    // Ask mode keywords (questions, learning, exploration)
    const askKeywords = [
      "explain",
      "what is",
      "how does",
      "why",
      "understand",
      "learn",
      "show me",
      "tell me",
    ];
    if (
      askKeywords.some((keyword) => lowerText.includes(keyword)) ||
      lowerText.endsWith("?")
    ) {
      return "ask";
    }

    // Default: Agent mode (writing/editing code)
    return null; // null means use the default Agent mode
  }

  /**
   * Convert a mode name to a user-friendly display name
   */
  private getModeDisplayName(mode: string): string {
    const modeNames: { [key: string]: string } = {
      agent: "Agent (coding)",
      ask: "Ask (questions/learning)",
      plan: "Plan (planning)",
      debug: "Debug (bug fixing)",
      auto: "Auto (automatic)",
    };
    return modeNames[mode] || mode;
  }
}
