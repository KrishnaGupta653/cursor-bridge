import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";

import { WebSocketServer } from "./websocket-server";
import * as vscode from "vscode";
import { CONFIG } from "./config";

interface ChatHistoryEntry {
  id: string;
  sessionId: string;
  clientId: string;
  userMessage: string;
  assistantResponse: string;
  timestamp: string;
  agentMode?: string; // 에이전트 모드 (agent, ask, plan, debug, auto)
  relaySessionId?: string; // 릴레이 모드일 때 릴레이 세션 ID
}

interface ChatHistory {
  entries: ChatHistoryEntry[];
  lastUpdated: string;
}

export class CLIHandler {
  private outputChannel: vscode.OutputChannel | null = null;
  private wsServer: WebSocketServer | null = null;
  private currentProcess: child_process.ChildProcess | null = null;
  private workspaceRoot: string | null = null;
  private processingOutput: boolean = false;
  private lastChatId: string | null = null; // 마지막 채팅 세션 ID (대화형 모드 테스트용)
  private clientSessions: Map<string, string> = new Map(); // 클라이언트별 세션 ID 관리
  private chatHistoryFile: string | null = null; // 대화 히스토리 파일 경로
  private pendingHistoryIds: Map<string, string> = new Map(); // clientId -> pending sessionId (실제 sessionId로 업데이트용)
  private streamingBuffers: Map<string, string> = new Map(); // clientId -> stdout buffer (스트리밍용)
  private lastStreamedText: Map<string, string> = new Map(); // clientId -> 마지막으로 전송한 텍스트 (중복 제거용)
  private lastPromptByClient: Map<string, string> = new Map(); // clientId -> 마지막으로 실행한 프롬프트 (IME 중복 방지용)
  private currentSenderDeviceId: string | null = null; // 유니캐스트 응답용 - 현재 요청을 보낸 모바일 디바이스 ID
  private getRelaySessionId: (() => string | null) | null = null; // 릴레이 세션 ID 조회 (저장 시 사용)

  constructor(
    outputChannel?: vscode.OutputChannel,
    wsServer?: WebSocketServer,
    workspaceRoot?: string
  ) {
    this.outputChannel = outputChannel || null;
    this.wsServer = wsServer || null;
    this.workspaceRoot = workspaceRoot || null;

    // 대화 히스토리 파일 경로 설정 (워크스페이스가 없거나 루트(/)면 스킵 - F5 테스트 시 ENOENT 방지)
    const safeWorkspaceRoot =
      workspaceRoot && workspaceRoot !== "/" && workspaceRoot.length > 1;
    if (safeWorkspaceRoot) {
      const cursorDir = path.join(workspaceRoot, ".cursor");
      if (!fs.existsSync(cursorDir)) {
        fs.mkdirSync(cursorDir, { recursive: true });
      }
      this.chatHistoryFile = path.join(cursorDir, "CHAT_HISTORY.json");
    }
  }

  /** 릴레이 모드일 때 저장되는 히스토리에 relaySessionId를 넣기 위한 getter 설정 */
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

    // 중요 로그는 클라이언트에게 전송
    if (sendToClient && this.wsServer) {
      this.wsServer.broadcast(
        JSON.stringify({
          type: "log",
          level: "info",
          message: `[CLI] ${message}`,
          timestamp: new Date().toISOString(),
          source: "cli",
        })
      );
    }
  }

  private logError(message: string, error?: any, sendToClient: boolean = true) {
    const timestamp = new Date().toLocaleTimeString();
    const errorStr =
      error instanceof Error ? error.message : String(error || "");
    const logMessage = `[${timestamp}] [CLI] ERROR: ${message}${
      errorStr ? ` - ${errorStr}` : ""
    }`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    console.error(logMessage);

    // 에러는 기본적으로 클라이언트에게 전송
    if (sendToClient && this.wsServer) {
      this.wsServer.broadcast(
        JSON.stringify({
          type: "log",
          level: "error",
          message: `[CLI] ${message}`,
          timestamp: new Date().toISOString(),
          source: "cli",
          error: errorStr,
        })
      );
    }
  }

  /**
   * Cursor CLI가 설치되어 있는지 확인
   */
  private async checkCLIInstalled(): Promise<boolean> {
    return new Promise(async (resolve) => {
      // PATH에서 찾기
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

          // 일반적인 설치 경로 확인
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

          // 파일 존재 여부 확인
          const exists = commonPaths.some((cliPath) => fs.existsSync(cliPath));
          resolve(exists);
        });
      });
    });
  }

  /**
   * Cursor CLI 명령어 경로 찾기
   */
  private async findCLICommand(): Promise<string> {
    return new Promise((resolve) => {
      // 1. PATH에서 'agent' 찾기
      child_process.exec("which agent", (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim());
          return;
        }

        // 2. PATH에서 'cursor-agent' 찾기
        child_process.exec("which cursor-agent", (error2, stdout2) => {
          if (!error2 && stdout2.trim()) {
            resolve(stdout2.trim());
            return;
          }

          // 3. 일반적인 설치 경로 확인
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

          // 파일 존재 여부 확인
          let found = false;
          for (const cliPath of commonPaths) {
            if (fs.existsSync(cliPath)) {
              resolve(cliPath);
              found = true;
              break;
            }
          }

          // 4. 찾지 못한 경우 기본값 (PATH에 있다고 가정)
          if (!found) {
            resolve("agent");
          }
        });
      });
    });
  }

  /**
   * Cursor CLI에 프롬프트 전송
   * @param text 프롬프트 텍스트
   * @param execute 실행 여부
   * @param clientId 클라이언트 ID (세션 격리용, 선택사항)
   * @param newSession 새 세션 시작 여부 (클라이언트에서 결정, 기본값: false)
   * @param agentMode 에이전트 모드 (agent, ask, plan, debug, auto)
   * @param senderDeviceId 릴레이 모드에서 요청을 보낸 모바일 디바이스 ID (유니캐스트 응답용)
   */
  async sendPrompt(
    text: string,
    execute: boolean = true,
    clientId?: string,
    newSession: boolean = false,
    agentMode: "agent" | "ask" | "plan" | "debug" | "auto" = "auto",
    senderDeviceId?: string
  ): Promise<void> {
    // 유니캐스트 응답용 디바이스 ID 저장
    this.currentSenderDeviceId = senderDeviceId || null;

    this.log(
      `sendPrompt called - textLength: ${
        text.length
      }, execute: ${execute}, clientId: ${
        clientId || "none"
      }, newSession: ${newSession}, senderDeviceId: ${senderDeviceId || "none"}`
    );

    // IME 중복 단일 문자 무시: 이미 실행 중인 프로세스가 있고, 새 프롬프트가 1글자이며
    // 마지막 프롬프트가 그 글자로 끝나면 무시 (릴레이 모드 응답 유지)
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

    // 에이전트 모드 설정 (히스토리 저장 및 CLI 실행에 사용)
    let selectedMode: string = "agent"; // 기본값
    if (agentMode && agentMode !== "auto") {
      selectedMode = agentMode;
    } else if (agentMode === "auto") {
      // 자동 모드: 텍스트 내용을 분석하여 적절한 모드 선택
      const autoMode = this.detectAgentMode(text);
      selectedMode = autoMode || "agent"; // 기본 Agent 모드
    }

    // 대화 히스토리 저장 (사용자 메시지 전송 시)
    // 세션 ID는 나중에 응답에서 받을 수 있으므로, 임시로 저장
    // 주의: newSession이 true면 기존 세션을 무시하므로 히스토리도 새로 시작
    if (clientId) {
      const currentSessionId = newSession
        ? null
        : this.clientSessions.get(clientId) || null;
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .substring(7)}`; // 고유한 임시 ID 사용
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
      // pending ID를 저장하여 나중에 실제 sessionId로 업데이트할 수 있도록
      if (!currentSessionId) {
        this.pendingHistoryIds.set(clientId, pendingId);
        this.log(
          `💾 Saved pending history ID: ${pendingId} for client ${clientId}`
        );
      }
    }

    try {
      // CLI 설치 확인
      const isInstalled = await this.checkCLIInstalled();
      if (!isInstalled) {
        throw new Error(
          "Cursor CLI (agent) is not installed. Install it from https://cursor.com/cli"
        );
      }

      const cliCommand = await this.findCLICommand();
      this.log(`Using CLI command: ${cliCommand}`);

      // 테스트: 대화형 모드에서는 프로세스를 유지하거나 --continue 옵션 사용
      // 현재는 기존 프로세스 종료 로직 유지 (대화형 모드 테스트 후 결정)
      if (this.currentProcess) {
        this.log("Stopping previous CLI process");
        const previousProcess = this.currentProcess;
        this.currentProcess = null;

        // 이전 프로세스가 죽었을 때 stdout 'end'가 호출되지 않으므로
        // 스트리밍 상태를 여기서 초기화해야 함. 그렇지 않으면 다음 프롬프트에서
        // wasStreaming이 true로 남아 최종 chat_response가 건너뛰어져 모바일에서 응답이 안 보임.
        this.streamingBuffers.clear();
        this.lastStreamedText.clear();

        // 프로세스 종료 (SIGTERM)
        previousProcess.kill("SIGTERM");

        // 프로세스가 완전히 종료될 때까지 최대 2초 대기
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            // 타임아웃 시 강제 종료
            if (!previousProcess.killed) {
              previousProcess.kill("SIGKILL");
            }
            resolve();
          }, 2000);

          previousProcess.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        this.log("Previous CLI process stopped");
      }

      // Cursor CLI 실행
      // 스트리밍을 위해 --output-format stream-json과 --stream-partial-output 사용
      // --force: 자동 실행 (승인 없이)
      const args: string[] = [];

      // 클라이언트에서 새 세션 시작 여부 결정
      if (newSession) {
        // 클라이언트가 명시적으로 새 세션을 요청한 경우
        this.log(
          `Starting new session (client requested) for client ${
            clientId || "global"
          }`
        );
      } else {
        // 기존 세션 재개 시도
        let sessionId: string | null = null;
        if (clientId) {
          sessionId = this.clientSessions.get(clientId) || null;
        } else {
          // clientId가 없으면 전역 세션 사용 (하위 호환성)
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
          // 세션이 없으면 새로 시작
          this.log(
            `Starting new chat session for client ${
              clientId || "global"
            } (no existing session)`
          );
        }
      }

      // CLI에는 plan/ask만 전달. debug는 CLI가 지원하지 않으므로 agent로 대체해 전달하지 않음
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

      // 선택된 모드를 사용자에게 알림 (로그를 통해, 표시용으로는 selectedMode 유지)
      const modeDisplayName = this.getModeDisplayName(selectedMode);
      this.log(`🤖 Agent Mode: ${modeDisplayName} (${selectedMode})`, true);

      // 자동 모드로 선택된 경우, 실제 선택된 모드를 모바일 앱에 전송
      if (agentMode === "auto" && this.wsServer) {
        this.wsServer.send(
          JSON.stringify({
            type: "agent_mode_selected",
            requestedMode: "auto",
            actualMode: selectedMode,
            displayName: modeDisplayName,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // 스트리밍 지원: stream-json 형식과 부분 출력 스트리밍 활성화
      // -p: 비대화형 모드 (--stream-partial-output과 함께 사용)
      // --output-format stream-json: 스트리밍 JSON 형식
      // --stream-partial-output: 부분 출력 스트리밍
      args.push(
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        text
      );

      this.log(`Executing CLI command...`, true);

      // 현재 작업 디렉토리 설정
      const cwd = this.workspaceRoot || process.cwd();

      // stdout 버퍼링 최소화를 위한 환경 변수 설정
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: "1", // Python 스크립트 버퍼링 비활성화 (만약 사용하는 경우)
        NODE_NO_WARNINGS: "1",
      };

      this.currentProcess = child_process.spawn(cliCommand, args, {
        cwd: cwd,
        stdio: ["ignore", "pipe", "pipe"], // stdin은 무시, stdout/stderr는 파이프
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
      let processClosed = false;

      // 현재 프롬프트의 clientId를 클로저로 저장 (checkAndProcessOutput에서 사용)
      const currentClientId = clientId;

      // IME 중복 판별용: 이번에 실행한 프롬프트 저장
      this.lastPromptByClient.set(clientId || "global", text);

      // 디버깅: clientId가 제대로 전달되는지 로그
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

      // stdout 수집 및 실시간 스트리밍
      if (this.currentProcess.stdout) {
        // 버퍼링 최소화: 즉시 플러시되도록 설정
        this.currentProcess.stdout.setEncoding("utf8");

        // 스트리밍 버퍼 초기화
        if (currentClientId) {
          this.streamingBuffers.set(currentClientId, "");
          this.lastStreamedText.set(currentClientId, "");
        }

        this.currentProcess.stdout.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stdout += chunk;
          this.log(
            `CLI stdout chunk (${chunk.length} bytes): ${chunk.substring(
              0,
              200
            )}${chunk.length > 200 ? "..." : ""}`
          );
          // 청크 전송 비활성화: 로컬/릴레이 모두 최종 chat_response만 사용
        });

        this.currentProcess.stdout.on("end", () => {
          this.log("CLI stdout stream ended");
          stdoutEnded = true;

          // 스트리밍 완료 신호 전송
          if (currentClientId && this.wsServer) {
            const completeMessage = {
              type: "chat_response_complete",
              timestamp: new Date().toISOString(),
              clientId: currentClientId,
            };
            this.wsServer.send(JSON.stringify(completeMessage));
            this.log("✅ Streaming complete signal sent");

            // 스트리밍 버퍼 정리
            this.streamingBuffers.delete(currentClientId);
            this.lastStreamedText.delete(currentClientId);
          }

          // 프로세스가 종료된 후에만 처리 (중복 방지)
          if (processClosed) {
            this.checkAndProcessOutput(stdout, stderr, currentClientId);
          }
        });

        this.currentProcess.stdout.on("error", (error) => {
          this.logError("CLI stdout stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stdout is null");
      }

      // stderr 수집
      if (this.currentProcess.stderr) {
        // 버퍼링 비활성화 (가능한 경우)
        this.currentProcess.stderr.setEncoding("utf8");

        this.currentProcess.stderr.on("data", (data: Buffer | string) => {
          const chunk = typeof data === "string" ? data : data.toString();
          stderr += chunk;
          this.logError(
            `CLI stderr chunk (${chunk.length} bytes): ${chunk.substring(
              0,
              200
            )}${chunk.length > 200 ? "..." : ""}`
          );
        });

        this.currentProcess.stderr.on("end", () => {
          this.log("CLI stderr stream ended");
          stderrEnded = true;
          // 프로세스가 종료된 후에만 처리 (중복 방지)
          if (processClosed) {
            this.checkAndProcessOutput(stdout, stderr, currentClientId);
          }
        });

        this.currentProcess.stderr.on("error", (error) => {
          this.logError("CLI stderr stream error", error);
        });
      } else {
        this.logError("⚠️ CLI process stderr is null");
      }

      // 프로세스 에러 처리
      this.currentProcess.on("error", (error) => {
        this.logError("CLI process spawn error", error);
        this.currentProcess = null;

        if (this.wsServer) {
          this.wsServer.send(
            JSON.stringify({
              type: "error",
              message: `CLI execution failed: ${error.message}`,
              timestamp: new Date().toISOString(),
            })
          );
        }
      });

      // 프로세스 종료 처리
      this.currentProcess.on("close", (code, signal) => {
        this.log(
          `CLI process exited with code ${code}, signal: ${signal || "none"}`
        );
        this.log(
          `Final stdout length: ${stdout.length}, stderr length: ${stderr.length}`
        );
        this.log(`stdout ended: ${stdoutEnded}, stderr ended: ${stderrEnded}`);

        processClosed = true;

        if (stdout.length === 0 && stderr.length === 0) {
          this.logError("⚠️ No output received from CLI process");
          this.logError(
            "⚠️ This might indicate the process was killed or did not produce output"
          );
        }

        // 프로세스가 종료되었으므로 출력 처리 (한 번만)
        // 스트림이 아직 끝나지 않았어도 프로세스가 종료되었으므로 처리
        this.checkAndProcessOutput(stdout, stderr, currentClientId);

        this.currentProcess = null;
      });

      this.currentProcess.on("error", (error) => {
        this.logError("CLI process error", error);
        this.currentProcess = null;

        if (this.wsServer) {
          this.wsServer.send(
            JSON.stringify({
              type: "error",
              message: `CLI execution failed: ${error.message}`,
              timestamp: new Date().toISOString(),
            })
          );
        }
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`Error in sendPrompt: ${errorMsg}`);
      throw new Error(`Failed to send CLI prompt: ${errorMsg}`);
    }
  }

  /**
   * CLI 출력 처리 및 WebSocket으로 전송
   * @param clientId 클라이언트 ID (세션 격리용, 선택사항)
   */
  private checkAndProcessOutput(
    stdout: string,
    stderr: string,
    clientId?: string
  ) {
    // 중복 처리 방지
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

    // 일반 텍스트 출력 처리 (JSON 형식 사용 안 함, 스트리밍용)
    try {
      if (stdout.length > 0) {
        this.log(`CLI stdout content: ${stdout.substring(0, 500)}`);
      }

      // stream-json 형식: 여러 JSON 라인이 있을 수 있음
      // 각 라인을 파싱하여 result 타입의 최종 결과 추출
      let responseText = "";
      let extractedSessionId: string | null = null;

      // 각 라인을 파싱하여 result 타입 찾기
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line.trim());

          // session_id 추출
          const sessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (sessionId && !extractedSessionId) {
            extractedSessionId = sessionId;
          }

          // result 타입: 최종 결과
          if (jsonData.type === "result" && jsonData.result) {
            if (typeof jsonData.result === "string") {
              responseText = jsonData.result;
            }
          }
          // assistant 타입: 스트리밍이 이미 완료되었으므로 무시
          // (스트리밍이 작동했다면 이미 전송됨)
        } catch (e) {
          // JSON 파싱 실패 시 해당 라인 무시
          continue;
        }
      }

      // result 타입을 찾지 못한 경우, 스트리밍된 텍스트 사용
      if (!responseText && clientId) {
        responseText = this.lastStreamedText.get(clientId) || "";
      }

      // 여전히 없으면 전체 stdout 사용 (하위 호환성)
      if (!responseText) {
        responseText = stdout.trim();
      }
      // CLI 에러 시 stderr를 사용자에게 전달 (응답이 비어 있을 때)
      if (!responseText && stderr.trim()) {
        responseText = `[CLI Error]\n${stderr.trim()}`;
        this.log(
          `Using stderr as response (CLI failed): ${stderr.substring(0, 100)}`
        );
      }

      // session_id 저장 (JSON에서 추출한 경우)
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
      if (!responseText && clientId === "relay-client") {
        this.log(
          `⚠️ Relay mode: no responseText (stdout length: ${stdout.length}, stderr length: ${stderr.length}) - sending fallback message`
        );
        responseText =
          stdout.length > 0
            ? stdout.trim().substring(0, 2000) || "[CLI output was empty.]"
            : stderr.length > 0
            ? `[CLI stderr]\n${stderr.trim().substring(0, 1000)}`
            : "[Response was empty. The CLI may not have returned any output.]";
      }

      // 대화 히스토리 저장 (응답 수신 시)
      const currentSessionId =
        extractedSessionId ||
        (clientId ? this.clientSessions.get(clientId) : this.lastChatId);
      if (clientId) {
        // sessionId가 있으면 사용, 없으면 pending ID 사용
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

        // pending ID가 있었고 실제 sessionId를 받았으면 업데이트
        if (extractedSessionId && this.pendingHistoryIds.has(clientId)) {
          const pendingId = this.pendingHistoryIds.get(clientId)!;
          this.log(
            `💾 Updating pending sessionId ${pendingId} to ${extractedSessionId}`
          );
          this.updatePendingSessionId(clientId, pendingId, extractedSessionId);
          this.pendingHistoryIds.delete(clientId);
        }
      }

      // WebSocket으로 최종 응답 전송
      // Relay 모드에서는 chat_response_chunk를 보내지 않으므로, 최종 chat_response는 항상 전송해야 함.
      // 로컬만 쓸 때도 스트리밍 후 최종 메시지를 보내면 앱이 덮어쓰기/완료 처리 가능.
      if (this.wsServer && responseText) {
        const responseMessage = {
          type: "chat_response",
          text: responseText,
          timestamp: new Date().toISOString(),
          source: "cli",
          sessionId: currentSessionId || undefined,
          clientId: clientId || undefined,
          targetDeviceId: this.currentSenderDeviceId || undefined, // 유니캐스트 응답용
        };

        this.log(
          `Sending chat_response: ${JSON.stringify(responseMessage).substring(
            0,
            200
          )}`
        );
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
      // 에러 발생 시 전체 출력을 텍스트로 전송
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logError(`Output processing error: ${errorMsg}`);
      this.logError(`stdout: ${stdout.substring(0, 500)}`);

      if (this.wsServer) {
        const responseMessage = {
          type: "chat_response",
          text: stdout || stderr || "CLI finished",
          timestamp: new Date().toISOString(),
          source: "cli",
          targetDeviceId: this.currentSenderDeviceId || undefined, // 유니캐스트 응답용
        };

        this.log(
          `Sending chat_response (fallback): ${JSON.stringify(
            responseMessage
          ).substring(0, 200)}`
        );
        this.wsServer.send(JSON.stringify(responseMessage));
        this.log("✅ Chat response sent to WebSocket (fallback)");
      }
    } finally {
      this.processingOutput = false;
      this.currentSenderDeviceId = null; // 응답 완료 후 초기화
    }
  }

  /**
   * 실시간 스트리밍 청크 처리
   * stream-json 형식: 각 델타가 JSON으로 출력됨
   * - thinking 타입: 내부 사고 과정 (스트리밍하지 않음)
   * - assistant 타입: 실제 응답 텍스트 (스트리밍)
   * - result 타입: 최종 결과 (스트리밍 완료 시 사용)
   */
  private processStreamingChunk(buffer: string, clientId: string) {
    // 청크 전송 비활성화: 로컬/릴레이 모두 최종 chat_response만 사용
    return;
    try {
      // stream-json 형식: 각 라인이 JSON 델타일 수 있음
      // 버퍼를 라인 단위로 분리하여 각 JSON 델타 처리
      const lines = buffer.split("\n").filter((line) => line.trim().length > 0);

      let accumulatedText = this.lastStreamedText.get(clientId) || "";
      let hasNewData = false;

      for (const line of lines) {
        try {
          // JSON 델타 파싱 시도
          const jsonData = JSON.parse(line.trim());

          // session_id 추출 (있는 경우)
          const extractedSessionId =
            jsonData.session_id ||
            jsonData.sessionId ||
            jsonData.chatId ||
            jsonData.chat_id;
          if (extractedSessionId && clientId) {
            this.clientSessions.set(clientId, extractedSessionId);
          }

          // 타입별 처리
          const messageType = jsonData.type;

          if (messageType === "assistant") {
            // assistant 타입: 실제 응답 텍스트 추출
            const message = jsonData.message;
            if (message && message.content && Array.isArray(message.content)) {
              for (const content of message.content) {
                if (content.type === "text" && content.text) {
                  const text = content.text;
                  // 이전 텍스트와 비교하여 새로운 부분만 추가
                  if (
                    text.length > accumulatedText.length &&
                    text.startsWith(accumulatedText)
                  ) {
                    // 새로운 텍스트가 이전 텍스트로 시작하는 경우 (일반적인 경우)
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (
                    accumulatedText.length > 0 &&
                    text.startsWith(accumulatedText) &&
                    text.length >= accumulatedText.length
                  ) {
                    // 이전 텍스트로 시작하지만 길이가 같거나 더 긴 경우
                    accumulatedText = text;
                    hasNewData = true;
                  } else if (text !== accumulatedText && text.length > 0) {
                    // 텍스트가 완전히 바뀐 경우 또는 처음 시작하는 경우
                    accumulatedText = text;
                    hasNewData = true;
                  }
                }
              }
            }
          } else if (messageType === "result" && jsonData.result) {
            // result 타입: 최종 결과 (전체 텍스트로 교체)
            const resultText = jsonData.result;
            if (typeof resultText === "string" && resultText.length > 0) {
              accumulatedText = resultText;
              hasNewData = true;
            }
          }
          // thinking 타입은 무시 (내부 사고 과정)
          // system, user 타입도 무시
        } catch (parseError) {
          // JSON이 아닌 경우 무시 (stream-json 형식에서는 모든 라인이 JSON이어야 함)
          // 일반 텍스트 출력은 하위 호환성을 위해 지원하지 않음
        }
      }

      // 새로운 데이터가 있으면 전송
      if (hasNewData && this.wsServer) {
        const lastText = this.lastStreamedText.get(clientId) || "";

        // accumulatedText가 lastText와 다른 경우 전송
        if (accumulatedText !== lastText) {
          const newText =
            accumulatedText.length > lastText.length
              ? accumulatedText.substring(lastText.length)
              : accumulatedText; // 처음 시작하는 경우 전체 텍스트

          if (newText.length > 0 || accumulatedText.length > 0) {
            const currentSessionId =
              this.clientSessions.get(clientId) || undefined;

            const chunkMessage = {
              type: "chat_response_chunk",
              text: newText.length > 0 ? newText : accumulatedText, // newText가 비어있으면 전체 텍스트 사용
              fullText: accumulatedText,
              timestamp: new Date().toISOString(),
              source: "cli",
              sessionId: currentSessionId || undefined,
              clientId: clientId,
              isReplace: newText.length === 0, // 처음 시작하거나 전체 교체인 경우
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
      // 에러 발생 시 로그만 남기고 계속 진행
      this.logError("Error processing streaming chunk", error);
    }
  }

  /**
   * 실행 중인 CLI 프로세스 중지
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
        this.logError(`Error stopping CLI process: ${errorMsg}`);
        return { success: false };
      }
    }

    return { success: true };
  }

  /**
   * CLI 핸들러 정리
   */
  dispose() {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  /**
   * 대화 히스토리 저장
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

      // 기존 히스토리 로드
      if (fs.existsSync(this.chatHistoryFile)) {
        const content = fs.readFileSync(this.chatHistoryFile, "utf8");
        try {
          const parsed = JSON.parse(content);
          // 기존 형식(배열)을 새 형식으로 변환
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
            // 새 형식
            history = parsed;
          } else {
            // 알 수 없는 형식
            this.log("⚠️ Unknown chat history format, resetting");
            history = { entries: [], lastUpdated: new Date().toISOString() };
          }
          // entries가 배열인지 확인
          if (!Array.isArray(history.entries)) {
            this.log("⚠️ history.entries is not an array, resetting");
            history.entries = [];
          }
        } catch (e) {
          this.logError("Failed to parse chat history", e);
          history = { entries: [], lastUpdated: new Date().toISOString() };
        }
      }

      // 새 엔트리 생성
      const newEntry: ChatHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        sessionId: entry.sessionId || "unknown",
        clientId: entry.clientId,
        userMessage: entry.userMessage || "",
        assistantResponse: entry.assistantResponse || "",
        timestamp: entry.timestamp,
        agentMode: entry.agentMode, // 에이전트 모드 추가
      };
      // 릴레이 모드일 때 릴레이 세션 ID 함께 저장
      if (entry.clientId === "relay-client" && this.getRelaySessionId) {
        const rid = this.getRelaySessionId();
        if (rid) newEntry.relaySessionId = rid;
      }

      // 디버깅: agentMode 저장 확인
      if (newEntry.userMessage) {
        this.log(
          `💾 Creating new entry - agentMode: ${
            newEntry.agentMode || "undefined"
          }, userMessage: ${newEntry.userMessage.substring(0, 30)}...`
        );
      }

      // pending sessionId를 실제 sessionId로 업데이트
      if (newEntry.sessionId.startsWith("pending-") && entry.clientId) {
        const actualSessionId = this.clientSessions.get(entry.clientId);
        if (actualSessionId) {
          newEntry.sessionId = actualSessionId;
          // pending ID 제거
          this.pendingHistoryIds.delete(entry.clientId);
        }
      }

      // 마지막 엔트리 찾기 (같은 clientId, 사용자 메시지가 있고 응답이 없는 경우)
      // 또는 pending ID가 실제 sessionId로 업데이트되는 경우
      let lastEntry: ChatHistoryEntry | undefined = undefined;
      let lastEntryIndex = -1;

      // 역순으로 검색하여 가장 최근 엔트리 찾기
      for (let i = history.entries.length - 1; i >= 0; i--) {
        const entry = history.entries[i];
        if (entry.clientId === newEntry.clientId) {
          const timeDiff = Math.abs(
            new Date(entry.timestamp).getTime() -
              new Date(newEntry.timestamp).getTime()
          );
          // 사용자 메시지가 있고 응답이 없는 경우 (응답을 추가해야 함)
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
          // pending ID가 실제 sessionId로 업데이트되는 경우
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
          // 같은 sessionId인 경우 (이미 완성된 엔트리 업데이트)
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
        // 기존 엔트리 업데이트
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
        // agentMode 업데이트 (사용자 메시지가 있고 agentMode가 제공된 경우에만)
        // 응답만 저장하는 경우 agentMode를 덮어쓰지 않도록 주의
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
          // 응답만 저장하는 경우 기존 agentMode 유지
          this.log(
            `💾 Saving response only - preserving agentMode: ${
              lastEntry.agentMode || "undefined"
            }`
          );
        }
        // sessionId도 업데이트 (pending -> actual)
        if (
          lastEntry.sessionId.startsWith("pending-") &&
          !newEntry.sessionId.startsWith("pending-")
        ) {
          lastEntry.sessionId = newEntry.sessionId;
        }
        // 릴레이 세션 ID 업데이트 (릴레이 모드 응답 저장 시)
        if (newEntry.relaySessionId) {
          lastEntry.relaySessionId = newEntry.relaySessionId;
        }
        // 타임스탬프 업데이트
        lastEntry.timestamp = newEntry.timestamp;
        this.log(
          `💾 Entry updated - final agentMode: ${
            lastEntry.agentMode || "undefined"
          }`
        );
      } else {
        // 새 엔트리 추가
        history.entries.push(newEntry);
      }

      // 최대 100개만 유지
      if (history.entries.length > 100) {
        history.entries = history.entries.slice(-100);
      }

      history.lastUpdated = new Date().toISOString();

      // 파일 저장
      fs.writeFileSync(
        this.chatHistoryFile,
        JSON.stringify(history, null, 2),
        "utf8"
      );
      this.log(`💾 Chat history saved (${history.entries.length} entries)`);
    } catch (error) {
      this.logError("Failed to save chat history", error);
    }
  }

  /**
   * pending sessionId를 실제 sessionId로 업데이트
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

      // 기존 형식(배열)을 새 형식으로 변환
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

      // entries가 배열인지 확인
      if (!Array.isArray(history.entries)) {
        this.log(
          "⚠️ history.entries is not an array in updatePendingSessionId"
        );
        return;
      }

      // pending ID를 가진 엔트리를 찾아서 실제 sessionId로 업데이트
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
   * 대화 히스토리 조회
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

      // 기존 형식(배열)을 새 형식으로 변환
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
            agentMode: oldEntry.agentMode, // 기존 데이터에서도 agentMode 포함
          })),
          lastUpdated: new Date().toISOString(),
        };
      } else if (parsed.entries && Array.isArray(parsed.entries)) {
        history = parsed;
      } else {
        this.log("⚠️ Unknown chat history format in getChatHistory");
        return [];
      }

      // entries가 배열인지 확인
      if (!Array.isArray(history.entries)) {
        this.log("⚠️ history.entries is not an array in getChatHistory");
        return [];
      }

      let filtered = history.entries;

      // 클라이언트 ID로 필터링 (clientId가 제공된 경우만)
      if (clientId) {
        filtered = filtered.filter((entry) => entry.clientId === clientId);
      }
      // clientId가 없으면 모든 히스토리 반환 (최근 히스토리 조회용)

      // 세션 ID로 필터링 (Cursor CLI 채팅 스레드 ID)
      if (sessionId) {
        filtered = filtered.filter((entry) => entry.sessionId === sessionId);
      }
      // 릴레이 세션 ID로 필터링 (릴레이 모드에서 현재 세션만)
      if (relaySessionId) {
        filtered = filtered.filter(
          (entry) =>
            (entry as ChatHistoryEntry).relaySessionId === relaySessionId
        );
      }

      // 최신순으로 정렬하고 제한
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
   * 텍스트 내용을 분석하여 적절한 에이전트 모드 자동 선택
   */
  private detectAgentMode(
    text: string
  ): "agent" | "ask" | "plan" | "debug" | null {
    const lowerText = text.toLowerCase();

    // Debug 모드 키워드
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
      // 버그 관련 키워드가 있지만, 단순 질문인지 확인
      if (
        lowerText.includes("why") ||
        lowerText.includes("what") ||
        lowerText.includes("how") ||
        lowerText.includes("?")
      ) {
        // 질문 형태면 Ask 모드
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

    // Plan 모드 키워드
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
      // 복잡한 작업 키워드 확인
      const complexKeywords = [
        "multiple",
        "several",
        "many",
        "system",
        "module",
        "component",
        "project",
        "전체",
        "모든",
        "전반",
      ];
      if (complexKeywords.some((keyword) => lowerText.includes(keyword))) {
        return "plan";
      }
      // "프로젝트 분석", "전체 분석" 같은 패턴도 Plan 모드
      if (
        lowerText.includes("analyze") ||
        lowerText.includes("analysis") ||
        lowerText.includes("분석")
      ) {
        return "plan";
      }
    }

    // Ask 모드 키워드 (질문, 학습, 탐색)
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

    // 기본값: Agent 모드 (코드 작성/수정 작업)
    return null; // null이면 기본 Agent 모드 사용
  }

  /**
   * 모드 이름을 사용자 친화적인 표시 이름으로 변환
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
