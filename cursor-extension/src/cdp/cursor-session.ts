/**
 * CursorSession — one attached CDP target representing a Cursor window / Agent UI.
 * Acts as CursorAgentMonitor + CursorAgentController for a single session.
 */

import { CdpSessionSocket } from "./cdp-client";
import {
  CLICK_APPROVAL_SCRIPT,
  CLICK_AGENT_HISTORY_SCRIPT,
  EXTRACT_AGENT_DOM_SCRIPT,
  EXTRACT_AGENTS_HISTORY_SCRIPT,
  FIND_COMPOSER_AND_SUBMIT_SCRIPT,
} from "./dom-extractor";
import {
  AgentHistoryPayload,
  AgentMessage,
  AgentSessionState,
  CdpTargetInfo,
  CursorSessionSnapshot,
  DomExtractionResult,
  SupportLevel,
} from "./cdp-types";

function emptyFileChanges() {
  return {
    items: [],
    available: false,
    support: "NOT_CURRENTLY_ACCESSIBLE" as SupportLevel,
    note: "File changes not yet observed",
  };
}

export class CursorSession {
  readonly id: string;
  readonly targetId: string;
  title: string;
  url: string;
  workspace?: string;
  model?: string;
  state: AgentSessionState = "UNKNOWN";
  connected = false;
  lastActivity: string = new Date().toISOString();
  private socket: CdpSessionSocket | null = null;
  private lastFingerprint = "";
  private lastSnapshot: CursorSessionSnapshot | null = null;
  /** Rolling conversation buffer — survives partial DOM views. */
  private messageBuffer: AgentMessage[] = [];

  constructor(
    target: CdpTargetInfo,
    private readonly log: (msg: string) => void,
    private readonly logError: (msg: string, err?: unknown) => void,
    private readonly onClosed?: (session: CursorSession) => void
  ) {
    this.id = `cursor-${target.id}`;
    this.targetId = target.id;
    this.title = target.title || "Cursor";
    this.url = target.url || "";
  }

  async attach(webSocketDebuggerUrl: string): Promise<void> {
    if (this.socket) {
      await this.socket.dispose();
      this.socket = null;
    }
    const socket = new CdpSessionSocket(
      webSocketDebuggerUrl,
      this.log,
      this.logError,
      () => {
        // A socket replaced by attach() or disposed by detach() is not this session closing.
        if (this.socket !== socket) return;
        this.connected = false;
        this.log(`[CDP] Cursor session closed: ${this.title} (${this.targetId})`);
        this.onClosed?.(this);
      }
    );
    this.socket = socket;
    await this.socket.connect();
    await this.socket.send("Runtime.enable").catch(() => undefined);
    await this.socket.send("Page.enable").catch(() => undefined);
    this.connected = true;
    this.lastActivity = new Date().toISOString();
    this.log(`[CDP] Cursor session attached: ${this.title} (${this.targetId})`);
  }

  async detach(): Promise<void> {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      await socket.dispose();
    }
    this.connected = false;
  }

  async refresh(): Promise<{
    snapshot: CursorSessionSnapshot;
    changed: boolean;
  }> {
    if (!this.socket || !this.socket.connected) {
      this.connected = false;
      this.state = "ERROR";
      const snapshot = this.toSnapshot({
        messages: [],
        state: "ERROR",
        pendingApproval: null,
        plan: {
          title: "",
          steps: [],
          available: false,
          support: "NOT_CURRENTLY_ACCESSIBLE",
        },
        fileChanges: emptyFileChanges(),
        activity: [],
        notes: ["CDP session not connected"],
        fingerprint: `disconnected-${Date.now()}`,
      });
      return { snapshot, changed: true };
    }

    let extraction: DomExtractionResult;
    try {
      extraction = await this.socket.evaluate<DomExtractionResult>(
        EXTRACT_AGENT_DOM_SCRIPT
      );
    } catch (e) {
      this.logError("[CDP] DOM extraction failed", e);
      extraction = {
        messages: this.lastSnapshot?.messages || [],
        state: "UNKNOWN",
        pendingApproval: null,
        plan: {
          title: "",
          steps: [],
          available: false,
          support: "NOT_CURRENTLY_ACCESSIBLE",
        },
        fileChanges: this.lastSnapshot?.fileChanges || emptyFileChanges(),
        activity: this.lastSnapshot?.activity || [],
        notes: [
          `Extraction unavailable: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ],
        fingerprint: `error-${Date.now()}`,
      };
    }

    this.state = extraction.state || "UNKNOWN";
    if (extraction.workspace) this.workspace = extraction.workspace;
    if (extraction.model) this.model = extraction.model;
    this.lastActivity = new Date().toISOString();
    const mergedMessages = this.mergeMessages(
      this.messageBuffer,
      extraction.messages || []
    );
    this.messageBuffer = mergedMessages;
    extraction = { ...extraction, messages: mergedMessages };
    const changed = extraction.fingerprint !== this.lastFingerprint;
    this.lastFingerprint = extraction.fingerprint;
    const snapshot = this.toSnapshot(extraction);
    this.lastSnapshot = snapshot;
    return { snapshot, changed };
  }

  /**
   * Merge DOM extraction into rolling buffer so scrolled-away turns are not
   * dropped, streaming text grows in place, and optimistic locals reconcile.
   */
  private mergeMessages(
    prev: AgentMessage[],
    next: AgentMessage[]
  ): AgentMessage[] {
    if (!next.length && prev.length) return prev;
    const byId = new Map<string, AgentMessage>();
    for (const m of prev) byId.set(m.id, { ...m });

    const resolveLocal = (incoming: AgentMessage) => {
      if (!incoming.id.startsWith("local-") && incoming.role === "user") {
        for (const [id, old] of byId) {
          if (
            id.startsWith("local-") &&
            old.role === "user" &&
            (old.text === incoming.text ||
              incoming.text.startsWith(old.text) ||
              old.text.startsWith(incoming.text.slice(0, 80)))
          ) {
            byId.delete(id);
            break;
          }
        }
      }
    };

    for (const incoming of next) {
      resolveLocal(incoming);
      const old = byId.get(incoming.id);
      if (!old) {
        byId.set(incoming.id, { ...incoming });
        continue;
      }
      const text =
        incoming.text.length >= old.text.length ? incoming.text : old.text;
      byId.set(incoming.id, {
        ...old,
        ...incoming,
        text,
        status:
          incoming.text.length > old.text.length
            ? incoming.status || "streaming"
            : incoming.status || old.status || "complete",
        timestamp: old.timestamp || incoming.timestamp,
      });
    }

    // Keep prior messages not in this DOM slice (scrolled out of view)
    const nextIds = new Set(next.map((m) => m.id));
    const ordered: AgentMessage[] = [];
    for (const m of prev) {
      if (!nextIds.has(m.id) && byId.has(m.id)) {
        ordered.push(byId.get(m.id)!);
      }
    }
    for (const m of next) {
      const merged = byId.get(m.id);
      if (!merged) continue;
      const idx = ordered.findIndex((o) => o.id === m.id);
      if (idx >= 0) ordered[idx] = merged;
      else ordered.push(merged);
    }

    // Dedupe near-identical consecutive user/assistant blobs
    const deduped: AgentMessage[] = [];
    for (const m of ordered) {
      const last = deduped[deduped.length - 1];
      if (
        last &&
        last.role === m.role &&
        (last.text === m.text ||
          (m.text.startsWith(last.text) && m.text.length > last.text.length))
      ) {
        deduped[deduped.length - 1] = {
          ...last,
          ...m,
          text: m.text.length >= last.text.length ? m.text : last.text,
        };
        continue;
      }
      deduped.push(m);
    }
    return deduped.slice(-120);
  }

  async sendPrompt(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.socket?.connected) {
      return { ok: false, error: "CDP session not connected" };
    }
    try {
      const result = await this.socket.evaluate<{
        ok: boolean;
        error?: string;
      }>(FIND_COMPOSER_AND_SUBMIT_SCRIPT(text));
      this.lastActivity = new Date().toISOString();
      if (!result?.ok) {
        return {
          ok: false,
          error: result?.error || "Failed to submit prompt to Cursor UI",
        };
      }
      this.state = "RUNNING";
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async resolvePermission(
    approve: boolean
  ): Promise<{ ok: boolean; error?: string; label?: string }> {
    if (!this.socket?.connected) {
      return { ok: false, error: "CDP session not connected" };
    }
    try {
      const result = await this.socket.evaluate<{
        ok: boolean;
        error?: string;
        label?: string;
      }>(CLICK_APPROVAL_SCRIPT(approve));
      this.lastActivity = new Date().toISOString();
      return result || { ok: false, error: "No result from approval click" };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Best-effort Agents sidebar history scrape (Cursor Agents window). */
  async extractAgentHistory(): Promise<AgentHistoryPayload> {
    if (!this.socket?.connected) {
      return {
        available: false,
        support: "NOT_CURRENTLY_ACCESSIBLE",
        items: [],
        count: 0,
        note: "CDP session not connected",
      };
    }
    try {
      const result = await this.socket.evaluate<AgentHistoryPayload>(
        EXTRACT_AGENTS_HISTORY_SCRIPT
      );
      return (
        result || {
          available: false,
          support: "NOT_CURRENTLY_ACCESSIBLE",
          items: [],
          count: 0,
        }
      );
    } catch (e) {
      return {
        available: false,
        support: "NOT_CURRENTLY_ACCESSIBLE",
        items: [],
        count: 0,
        note: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async openHistoryItem(
    title: string,
    group?: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.socket?.connected) {
      return { ok: false, error: "CDP session not connected" };
    }
    // Switching Agents chats — drop previous conversation so history + live
    // messages for the newly opened thread are not mixed with the old one.
    this.messageBuffer = [];
    this.lastFingerprint = "";
    try {
      const result = await this.socket.evaluate<{
        ok: boolean;
        error?: string;
      }>(CLICK_AGENT_HISTORY_SCRIPT(title, group));
      this.lastActivity = new Date().toISOString();
      if (!result?.ok) {
        return {
          ok: false,
          error: result?.error || "Could not open history item in Cursor UI",
        };
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  getSnapshot(): CursorSessionSnapshot | null {
    return this.lastSnapshot;
  }

  /** Raw access for the Agents-window controller; scripts are fixed, never client-supplied. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (!this.socket?.connected) throw new Error("CDP session not connected");
    this.lastActivity = new Date().toISOString();
    return this.socket.evaluate<T>(expression);
  }

  async send(method: "Input.insertText" | "Input.dispatchKeyEvent", params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket?.connected) throw new Error("CDP session not connected");
    return this.socket.send(method, params);
  }

  toListItem() {
    const snap = this.lastSnapshot;
    const latestMsg = snap?.messages?.length
      ? snap.messages[snap.messages.length - 1].text.slice(0, 120)
      : undefined;
    return {
      id: this.id,
      title: this.title,
      workspace: this.workspace || snap?.workspace,
      state: this.state,
      connected: this.connected,
      targetId: this.targetId,
      latestMessage: latestMsg,
      latestActivity: snap?.latestActivity,
      lastActivity: this.lastActivity,
      hasPendingPermission: !!snap?.pendingApproval,
      model: this.model || snap?.model,
    };
  }

  private toSnapshot(extraction: DomExtractionResult): CursorSessionSnapshot {
    const messages = extraction.messages || [];
    const plan = extraction.plan
      ? {
          ...extraction.plan,
          support:
            extraction.plan.support ||
            (extraction.plan.available
              ? ("PARTIALLY_SUPPORTED" as SupportLevel)
              : ("NOT_CURRENTLY_ACCESSIBLE" as SupportLevel)),
        }
      : null;
    const fileChanges = extraction.fileChanges || emptyFileChanges();
    const conversationSupport: SupportLevel =
      messages.length > 0 ? "PARTIALLY_SUPPORTED" : "NOT_CURRENTLY_ACCESSIBLE";
    return {
      id: this.id,
      targetId: this.targetId,
      title: this.title,
      workspace: extraction.workspace || this.workspace,
      model: extraction.model || this.model,
      url: this.url,
      state: this.state,
      connected: this.connected,
      lastActivity: this.lastActivity,
      latestMessage: messages.length
        ? messages[messages.length - 1].text.slice(0, 160)
        : undefined,
      latestActivity: extraction.latestActivity,
      messages,
      plan,
      pendingApproval: extraction.pendingApproval,
      fileChanges,
      activity: extraction.activity || [],
      extractionNotes: extraction.notes,
      capabilities: {
        conversation: conversationSupport,
        plan: plan?.support || "NOT_CURRENTLY_ACCESSIBLE",
        permissions: extraction.pendingApproval
          ? "PARTIALLY_SUPPORTED"
          : "PARTIALLY_SUPPORTED",
        promptInject: "PARTIALLY_SUPPORTED",
        fileChanges: fileChanges.support,
      },
    };
  }
}
