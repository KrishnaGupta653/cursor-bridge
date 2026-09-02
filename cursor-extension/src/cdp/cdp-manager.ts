/**
 * CdpManager — discovers Cursor targets, attaches sessions, monitors state.
 * Android never talks to CDP directly; only allowlisted app APIs use this.
 */

import { CdpHttpClient } from "./cdp-client";
import { CursorSession } from "./cursor-session";
import { rankTargets } from "./cursor-target";
import {
  AgentHistoryPayload,
  AgentMessage,
  CdpStatusPayload,
  CdpTargetInfo,
  CursorSessionSnapshot,
} from "./cdp-types";

export interface CdpManagerOptions {
  host: string;
  port: number;
  enabled: boolean;
  pollIntervalMs?: number;
  log: (msg: string) => void;
  logError: (msg: string, err?: unknown) => void;
  broadcast: (payload: Record<string, unknown>) => void;
}

export class CdpManager {
  private http: CdpHttpClient;
  private sessions = new Map<string, CursorSession>();
  private targets: CdpTargetInfo[] = [];
  private activeSessionId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connected = false;
  private lastError: string | undefined;
  private disposed = false;
  private readonly pollIntervalMs: number;
  private history: AgentHistoryPayload = {
    available: false,
    support: "NOT_CURRENTLY_ACCESSIBLE",
    items: [],
    count: 0,
  };
  private historySourceSessionId: string | null = null;

  constructor(private options: CdpManagerOptions) {
    this.http = new CdpHttpClient({
      host: options.host,
      port: options.port,
      log: options.log,
      logError: options.logError,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Hot-enable/disable after settings change without full extension reload. */
  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled;
  }

  updateEndpoint(host: string, port: number): void {
    this.options.host = host;
    this.options.port = port;
    this.http = new CdpHttpClient({
      host,
      port,
      log: this.options.log,
      logError: this.options.logError,
    });
  }

  getStatus(): CdpStatusPayload {
    const sessions = this.listSessions();
    const summary = {
      working: 0,
      waiting: 0,
      idle: 0,
      error: 0,
    };
    for (const s of sessions) {
      const st = String(s.state).toUpperCase();
      if (st === "RUNNING") summary.working++;
      else if (
        st === "WAITING_FOR_PERMISSION" ||
        st === "WAITING_FOR_INPUT"
      ) {
        summary.waiting++;
      } else if (st === "ERROR") summary.error++;
      else summary.idle++;
    }
    return {
      type: "cdp_status",
      enabled: this.options.enabled,
      connected: this.connected,
      host: this.options.host,
      port: this.options.port,
      activeSessionId: this.activeSessionId,
      targets: this.targets,
      error: this.lastError,
      summary,
    };
  }

  async start(): Promise<void> {
    if (!this.options.enabled) {
      this.options.log("[CDP] Disabled (ENABLE_CDP / cursorRemote.enableCdp)");
      return;
    }
    this.disposed = false;
    this.options.log(
      `[CDP] Connecting to ${this.options.host}:${this.options.port}`
    );
    await this.connectAndDiscover();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const s of this.sessions.values()) {
      await s.detach();
    }
    this.sessions.clear();
    this.connected = false;
    this.options.log("[CDP] Disconnected");
  }

  private async connectAndDiscover(): Promise<void> {
    try {
      await this.http.getVersion();
      this.connected = true;
      this.lastError = undefined;
      this.reconnectAttempts = 0;
      this.options.log("[CDP] Connected");
      await this.rediscover();
      this.startPolling();
    } catch (e) {
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.options.logError("[CDP] Connection failed", e);
      this.scheduleReconnect();
    }
  }

  async rediscover(): Promise<CdpTargetInfo[]> {
    const all = await this.http.listTargets();
    this.targets = rankTargets(all);
    this.options.log(`[CDP] Discovered ${this.targets.length} candidate targets`);

    // Attach top candidates as sessions (max 5)
    const keep = new Set<string>();
    for (const t of this.targets.slice(0, 5)) {
      keep.add(t.id);
      const sessionId = `cursor-${t.id}`;
      let session = this.sessions.get(sessionId);
      if (!session) {
        session = new CursorSession(t, this.options.log, this.options.logError);
        this.sessions.set(sessionId, session);
      } else {
        session.title = t.title || session.title;
        session.url = t.url || session.url;
      }
      if (!session.connected && t.webSocketDebuggerUrl) {
        try {
          await session.attach(t.webSocketDebuggerUrl);
          this.options.log(`[CDP] Cursor session detected: ${session.title}`);
          const { snapshot } = await session.refresh();
          this.options.log(`[CDP] Session state: ${snapshot.state}`);
          this.options.broadcast({
            type: "agent_state",
            sessionId: session.id,
            state: snapshot.state,
            messages: snapshot.messages,
            plan: snapshot.plan,
            pendingApproval: snapshot.pendingApproval,
            title: snapshot.title,
            extractionNotes: snapshot.extractionNotes,
          });
        } catch (e) {
          this.options.logError(
            `[CDP] Failed to attach target ${t.id}`,
            e
          );
        }
      }
    }

    // Drop stale sessions
    for (const [id, session] of [...this.sessions.entries()]) {
      if (!keep.has(session.targetId)) {
        await session.detach();
        this.sessions.delete(id);
        if (this.activeSessionId === id) this.activeSessionId = null;
      }
    }

    if (!this.activeSessionId && this.sessions.size > 0) {
      this.activeSessionId = [...this.sessions.keys()][0];
    }

    this.options.broadcast({
      type: "cdp_targets",
      targets: this.targets,
    });
    this.options.broadcast({
      type: "sessions",
      sessions: this.listSessions(),
    });
    await this.refreshAgentHistory().catch((e) =>
      this.options.logError("[CDP] History scrape failed", e)
    );

    return this.targets;
  }

  listSessions(): Array<{
    id: string;
    title: string;
    workspace?: string;
    state: string;
    connected: boolean;
    targetId: string;
    latestMessage?: string;
    latestActivity?: string;
    lastActivity?: string;
    hasPendingPermission?: boolean;
    kind?: string;
  }> {
    return [...this.sessions.values()].map((s) => ({
      ...s.toListItem(),
      kind: "live",
    }));
  }

  getAgentHistory(): AgentHistoryPayload {
    return {
      ...this.history,
      sourceSessionId: this.historySourceSessionId || undefined,
    };
  }

  /** Prefer the "Cursor Agents" window for sidebar history scrape. */
  private findAgentsWindowSession(): CursorSession | null {
    for (const s of this.sessions.values()) {
      if (/agent/i.test(s.title) && s.connected) return s;
    }
    for (const s of this.sessions.values()) {
      if (s.connected) return s;
    }
    return null;
  }

  async refreshAgentHistory(): Promise<AgentHistoryPayload> {
    const session = this.findAgentsWindowSession();
    if (!session) {
      this.history = {
        available: false,
        support: "NOT_CURRENTLY_ACCESSIBLE",
        items: [],
        count: 0,
        note: "No Cursor Agents window attached for history scrape",
      };
      this.historySourceSessionId = null;
      this.options.broadcast({
        type: "agent_history",
        ...this.history,
      });
      return this.history;
    }
    const payload = await session.extractAgentHistory();
    this.history = payload;
    this.historySourceSessionId = session.id;
    this.options.log(
      `[CDP] Agent history scraped: ${payload.count} items (${payload.support})`
    );
    this.options.broadcast({
      type: "agent_history",
      sessionId: session.id,
      ...payload,
    });
    return payload;
  }

  async openAgentHistoryItem(
    historyId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const item = this.history.items.find((h) => h.id === historyId);
    if (!item) {
      return { ok: false, error: "History item not found (refresh history)" };
    }
    const session =
      (this.historySourceSessionId &&
        this.sessions.get(this.historySourceSessionId)) ||
      this.findAgentsWindowSession();
    if (!session) {
      return { ok: false, error: "No Cursor Agents window to open history in" };
    }
    this.activeSessionId = session.id;
    const result = await session.openHistoryItem(item.title, item.group);
    if (result.ok) {
      this.options.log(
        `[CDP] Opened history item: ${item.title} (${item.group})`
      );
      // Wait for Agents UI to swap conversation, then refresh twice so
      // virtualized composer rows have time to mount (history + live).
      await new Promise((r) => setTimeout(r, 600));
      await session.refresh();
      await new Promise((r) => setTimeout(r, 700));
      const { snapshot } = await session.refresh();
      this.options.broadcast({
        type: "agent_state",
        sessionId: session.id,
        state: snapshot.state,
        messages: snapshot.messages,
        plan: snapshot.plan,
        pendingApproval: snapshot.pendingApproval,
        title: snapshot.title,
        workspace: snapshot.workspace || item.group,
        latestMessage: snapshot.latestMessage,
        fileChanges: snapshot.fileChanges,
        activity: snapshot.activity,
        extractionNotes: [
          ...(snapshot.extractionNotes || []),
          `Opened history: ${item.title}`,
        ],
      });
    }
    return result;
  }

  selectSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.activeSessionId = sessionId;
    return true;
  }

  getActiveSession(): CursorSession | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) || null;
  }

  async getAgentState(sessionId?: string): Promise<CursorSessionSnapshot | null> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getActiveSession();
    if (!session) return null;
    const { snapshot } = await session.refresh();
    return snapshot;
  }

  async sendAgentPrompt(
    text: string,
    sessionId?: string
  ): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getActiveSession();
    if (!session) {
      return { ok: false, error: "No active Cursor session selected" };
    }
    this.activeSessionId = session.id;
    const result = await session.sendPrompt(text);
    if (result.ok) {
      this.options.broadcast({
        type: "agent_state_changed",
        sessionId: session.id,
        state: "RUNNING",
      });
      // Optimistic user message echo for mobile UI
      const userMsg: AgentMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text,
        timestamp: new Date().toISOString(),
        status: "sent",
      };
      this.options.broadcast({
        type: "agent_message",
        sessionId: session.id,
        message: userMsg,
      });
    }
    return { ...result, sessionId: session.id };
  }

  async approveAction(
    sessionId?: string,
    _requestId?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getActiveSession();
    if (!session) return { ok: false, error: "No active Cursor session" };
    const result = await session.resolvePermission(true);
    if (result.ok) {
      this.options.log(`[CDP] Permission approved (${result.label || "button"})`);
      this.options.broadcast({
        type: "permission_resolved",
        sessionId: session.id,
        approved: true,
        label: result.label,
      });
    }
    return result;
  }

  async rejectAction(
    sessionId?: string,
    _requestId?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getActiveSession();
    if (!session) return { ok: false, error: "No active Cursor session" };
    const result = await session.resolvePermission(false);
    if (result.ok) {
      this.options.log(`[CDP] Permission rejected (${result.label || "button"})`);
      this.options.broadcast({
        type: "permission_resolved",
        sessionId: session.id,
        approved: false,
        label: result.label,
      });
    }
    return result;
  }

  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce() {
    if (this.disposed || !this.connected) return;
    try {
      // Light rediscovery occasionally
      if (Math.random() < 0.05) {
        await this.rediscover().catch(() => undefined);
      }
      for (const session of this.sessions.values()) {
        if (!session.connected) continue;
        const prev = session.getSnapshot();
        const { snapshot, changed } = await session.refresh();
        if (!changed) continue;

        this.options.log(`[CDP] Conversation updated (${session.title})`);
        this.options.broadcast({
          type: "agent_state_changed",
          sessionId: session.id,
          state: snapshot.state,
          workspace: snapshot.workspace,
          model: snapshot.model,
          latestMessage: snapshot.latestMessage,
          latestActivity: snapshot.latestActivity,
          hasPendingPermission: !!snapshot.pendingApproval,
        });
        this.options.broadcast({
          type: "agent_state",
          sessionId: snapshot.id,
          state: snapshot.state,
          messages: snapshot.messages,
          plan: snapshot.plan,
          pendingApproval: snapshot.pendingApproval,
          title: snapshot.title,
          workspace: snapshot.workspace,
          model: snapshot.model,
          fileChanges: snapshot.fileChanges,
          activity: snapshot.activity,
          latestMessage: snapshot.latestMessage,
          latestActivity: snapshot.latestActivity,
          lastActivity: snapshot.lastActivity,
          capabilities: snapshot.capabilities,
          extractionNotes: snapshot.extractionNotes,
        });
        this.options.broadcast({
          type: "sessions",
          sessions: this.listSessions(),
        });

        if (snapshot.pendingApproval) {
          this.options.log("[CDP] Permission request detected");
          this.options.broadcast({
            type: "permission_request",
            sessionId: session.id,
            request: snapshot.pendingApproval,
          });
        }

        if (
          prev?.plan?.available !== snapshot.plan?.available ||
          JSON.stringify(prev?.plan?.steps) !==
            JSON.stringify(snapshot.plan?.steps)
        ) {
          this.options.broadcast({
            type: "agent_plan_changed",
            sessionId: session.id,
            plan: snapshot.plan,
          });
        }

        if (
          JSON.stringify(prev?.fileChanges?.items) !==
          JSON.stringify(snapshot.fileChanges?.items)
        ) {
          this.options.broadcast({
            type: "file_changed",
            sessionId: session.id,
            fileChanges: snapshot.fileChanges,
          });
        }

        const prevAct = prev?.activity?.length || 0;
        if (snapshot.activity.length > prevAct) {
          for (const event of snapshot.activity.slice(prevAct)) {
            this.options.broadcast({
              type: "activity_event",
              sessionId: session.id,
              event,
            });
          }
        }

        if (
          prev &&
          prev.state === "RUNNING" &&
          (snapshot.state === "IDLE" || snapshot.state === "COMPLETED")
        ) {
          this.options.log("[CDP] Agent completed");
          this.options.broadcast({
            type: "agent_completed",
            sessionId: session.id,
          });
        }

        if (snapshot.state === "ERROR") {
          this.options.broadcast({
            type: "agent_error",
            sessionId: session.id,
            error: snapshot.extractionNotes?.join("; ") || "Agent error",
          });
        }

        // Id-based message sync — never rely on append-only length alone
        const prevById = new Map(
          (prev?.messages || []).map((m) => [m.id, m] as const)
        );
        for (const message of snapshot.messages) {
          const before = prevById.get(message.id);
          if (!before) {
            this.options.broadcast({
              type: "agent_message",
              sessionId: session.id,
              message,
            });
          } else if (message.text !== before.text) {
            this.options.broadcast({
              type: "agent_message_delta",
              sessionId: session.id,
              messageId: message.id,
              text: message.text,
              status: message.status,
            });
          }
        }
      }
    } catch (e) {
      this.options.logError("[CDP] Poll error", e);
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.stopPolling();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.disposed || !this.options.enabled) return;
    if (this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempts;
    if (attempt > 8) {
      this.options.log(
        "[CDP] Max reconnect attempts reached. Use cdp_status / restart Cursor with CDP."
      );
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
    this.options.log(`[CDP] Reconnecting in ${delay}ms (attempt ${attempt})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAndDiscover();
    }, delay);
  }
}
