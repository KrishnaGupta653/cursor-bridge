/**
 * CdpManager — discovers Cursor targets, attaches sessions, monitors state.
 * Android never talks to CDP directly; only allowlisted app APIs use this.
 */

import { AgentsWindow } from "./agents-window";
import { CdpHttpClient } from "./cdp-client";
import { CursorSession } from "./cursor-session";
import { rankTargets } from "./cursor-target";
import {
  AgentHistoryPayload,
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

interface ReplyWatcher {
  clientId: string;
  targetDeviceId?: string;
  baseline: Set<string>;
  startedAt: number;
  lastText: string;
  stableTicks: number;
}

const REPLY_SETTLE_TICKS = 2;
// Agents often pause output while running tools, so only force-settle after ~90s of no change.
const REPLY_FORCE_SETTLE_TICKS = 60;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const REDISCOVER_THROTTLE_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 30000;

export class CdpManager {
  private http: CdpHttpClient;
  private replyWatchers = new Map<string, ReplyWatcher>();
  private polling = false;
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
  private lastRediscoverAt = 0;
  private rediscovering: Promise<unknown> | null = null;
  readonly agents = new AgentsWindow(() => this.agentsWindowSession());

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
    // An explicit start (activation or settings change) gets a fresh reconnect budget.
    this.reconnectAttempts = 0;
    this.options.log(
      `[CDP] Connecting to ${this.options.host}:${this.options.port}`
    );
    await this.connectAndDiscover();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.stopPolling();
    this.replyWatchers.clear();
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
      if (this.replyWatchers.size > 0) this.startPolling();
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
        session = new CursorSession(t, this.options.log, this.options.logError, () => this.onSessionClosed());
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

  /** Only the dedicated Agents window: actions must never land in an editor window by accident. */
  private agentsWindowSession(): CursorSession | null {
    for (const s of this.sessions.values()) {
      if (s.connected && /^cursor agents$/i.test(s.title.trim())) return s;
    }
    this.rediscoverSoon();
    return null;
  }

  /** Picks up an Agents window opened (or reopened) after the last discovery, at most every few seconds. */
  private rediscoverSoon(): void {
    if (this.disposed || !this.connected || this.rediscovering) return;
    if (Date.now() - this.lastRediscoverAt < REDISCOVER_THROTTLE_MS) return;
    this.lastRediscoverAt = Date.now();
    this.rediscovering = this.rediscover()
      .catch((e) => {
        this.options.logError("[CDP] Rediscovery failed", e);
        this.connected = false;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.scheduleReconnect();
      })
      .finally(() => {
        this.rediscovering = null;
      });
  }

  /** With every window gone, Cursor itself probably quit: reconnect until it is back. */
  private onSessionClosed(): void {
    if (this.disposed) return;
    if ([...this.sessions.values()].some((s) => s.connected)) return;
    this.connected = false;
    this.lastError = "All Cursor windows closed";
    this.stopPolling();
    this.scheduleReconnect();
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
      return this.history;
    }
    const payload = await session.extractAgentHistory();
    this.history = payload;
    this.historySourceSessionId = session.id;
    this.options.log(
      `[CDP] Agent history scraped: ${payload.count} items (${payload.support})`
    );
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
      await session.refresh();
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
    sessionId?: string,
    replyTo?: { clientId: string; targetDeviceId?: string }
  ): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.getActiveSession();
    if (!session) {
      return { ok: false, error: "No active Cursor session selected" };
    }
    this.activeSessionId = session.id;
    // Baseline = messages already on screen, so only the new reply is delivered.
    const before = replyTo ? await session.refresh().catch(() => null) : null;
    const result = await session.sendPrompt(text);
    if (result.ok && replyTo) {
      const previous = this.replyWatchers.get(session.id);
      if (previous && previous.clientId !== replyTo.clientId) {
        this.deliverReply(session.id, previous, "Another prompt was sent to this session; its reply goes to the newer sender.");
      }
      this.replyWatchers.set(session.id, {
        ...replyTo,
        baseline: new Set((before?.snapshot.messages || session.getSnapshot()?.messages || []).map((m) => m.id)),
        startedAt: Date.now(),
        lastText: "",
        stableTicks: 0,
      });
      this.startPolling();
    }
    return { ...result, sessionId: session.id };
  }

  private startPolling() {
    if (this.pollTimer || !this.connected) return;
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

  /**
   * Scraping the Cursor DOM is expensive for the Cursor window itself, so polling only runs
   * while someone is waiting for a reply. Everything else refreshes on demand.
   */
  private async pollOnce() {
    if (this.disposed || !this.connected || this.polling) return;
    if (this.replyWatchers.size === 0) {
      this.stopPolling();
      return;
    }
    this.polling = true;
    try {
      for (const [sessionId, watcher] of [...this.replyWatchers.entries()]) {
        const session = this.sessions.get(sessionId);
        if (!session?.connected) {
          this.deliverReply(sessionId, watcher, "The Cursor session closed before replying.");
          continue;
        }
        const { snapshot } = await session.refresh();
        const reply = snapshot.messages
          .filter((m) => m.role === "assistant" && !watcher.baseline.has(m.id))
          .map((m) => m.text.trim())
          .filter(Boolean)
          .join("\n\n");
        watcher.stableTicks = reply && reply === watcher.lastText ? watcher.stableTicks + 1 : 0;
        watcher.lastText = reply;
        // State detection is heuristic, so a long-stable reply also counts as finished.
        const settled =
          (watcher.stableTicks >= REPLY_SETTLE_TICKS && snapshot.state !== "RUNNING") ||
          watcher.stableTicks >= REPLY_FORCE_SETTLE_TICKS;
        if (settled) {
          this.deliverReply(sessionId, watcher, reply);
        } else if (Date.now() - watcher.startedAt > REPLY_TIMEOUT_MS) {
          this.deliverReply(
            sessionId,
            watcher,
            reply || "No reply detected after 10 minutes. The agent may still be working — check the session in Cursor."
          );
        }
      }
    } catch (e) {
      this.options.logError("[CDP] Poll error", e);
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.stopPolling();
      this.scheduleReconnect();
    } finally {
      this.polling = false;
    }
  }

  private deliverReply(sessionId: string, watcher: ReplyWatcher, text: string) {
    this.replyWatchers.delete(sessionId);
    this.options.broadcast({
      type: "chat_response",
      clientId: watcher.clientId,
      targetDeviceId: watcher.targetDeviceId,
      sessionId,
      text,
      timestamp: new Date().toISOString(),
    });
    if (this.replyWatchers.size === 0) this.stopPolling();
  }

  private scheduleReconnect() {
    if (this.disposed || !this.options.enabled) return;
    if (this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * Math.pow(2, Math.min(attempt, 16) - 1));
    this.options.log(`[CDP] Reconnecting in ${delay}ms (attempt ${attempt})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAndDiscover();
    }, delay);
  }
}
