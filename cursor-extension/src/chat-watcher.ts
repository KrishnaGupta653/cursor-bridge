/**
 * ChatWatcher — per-client live updates for Agents-window chats.
 * History deltas come from the transcript file; running/approval state from a light
 * composer check. Nothing is broadcast: every payload carries its subscriber's identity.
 */

import { ComposerState, ActionResult } from "./cdp/agents-window";
import { ChatItem, TranscriptIndex } from "./transcripts/transcript-index";

export interface Subscriber {
  clientId: string;
  targetDeviceId?: string;
}

interface Watch extends Subscriber {
  chatId: string;
  lastTotal: number;
  mtimeMs: number;
  lastComposer: string;
  expiresAt: number;
  lastDeltaAt: number;
}

interface ReplyWait extends Subscriber {
  chatId: string | null;
  baseline: number;
  startedAt: number;
  idleChecks: number;
  correlationId?: string;
}

export interface ChatWatcherOptions {
  index: TranscriptIndex;
  composerState: () => Promise<ActionResult<{ state: ComposerState }>>;
  send: (payload: Record<string, unknown>) => void;
  logError: (msg: string, err?: unknown) => void;
  tickMs?: number;
}

const LOCAL_COMPOSER_MS = 2000;
const RELAY_COMPOSER_MS = 4000;
const OBSERVER_COMPOSER_MS = 5000;
const REPLY_IDLE_CHECKS = 2;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WATCHES = 50;
/** Relay clients cannot signal a disconnect, so a watch lapses unless the app renews it. */
const WATCH_TTL_MS = 10 * 60 * 1000;
/** Each relay push costs a function call and several Redis commands; coalesce transcript growth. */
const RELAY_DELTA_MS = 4000;

function key(s: Subscriber): string {
  return `${s.clientId}\u0000${s.targetDeviceId || ""}`;
}

function isRelay(s: Subscriber): boolean {
  return s.clientId.startsWith("relay:");
}

export class ChatWatcher {
  private watches = new Map<string, Watch>();
  private replies = new Map<string, ReplyWait>();
  private observers = new Set<(state: ComposerState) => void>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastComposerAt = 0;
  private lastState: ComposerState | null = null;

  constructor(private readonly options: ChatWatcherOptions) {}

  /** Start following a chat for one subscriber; replaces that subscriber's previous watch. */
  watch(sub: Subscriber, chatId: string, fromTotal: number, nowMs: number = Date.now()): void {
    const existing = this.watches.get(key(sub));
    if (existing && existing.chatId === chatId && existing.lastTotal <= fromTotal) {
      existing.expiresAt = nowMs + WATCH_TTL_MS;
      return;
    }
    if (!existing && this.watches.size >= MAX_WATCHES) {
      const oldest = this.watches.keys().next().value;
      if (oldest) this.watches.delete(oldest);
    }
    const now = this.options.index.since(chatId, fromTotal);
    const upToDate = !!now && now.total <= fromTotal;
    this.watches.set(key(sub), {
      clientId: sub.clientId,
      targetDeviceId: sub.targetDeviceId,
      chatId,
      lastTotal: Math.max(0, fromTotal),
      // A client that is behind gets the missing items on the first tick.
      mtimeMs: upToDate ? now!.mtimeMs : 0,
      lastComposer: "",
      expiresAt: nowMs + WATCH_TTL_MS,
      lastDeltaAt: 0,
    });
    this.lastComposerAt = 0;
    this.ensureTimer();
  }

  unwatch(sub: Subscriber): boolean {
    const removed = this.watches.delete(key(sub));
    this.stopIfIdle();
    return removed;
  }

  /** Called when a client disconnects so its watch and pending reply are dropped. */
  forgetClient(clientId: string): void {
    for (const [k, w] of this.watches) if (w.clientId === clientId) this.watches.delete(k);
    for (const [k, r] of this.replies) if (r.clientId === clientId) this.replies.delete(k);
    this.stopIfIdle();
  }

  /** Deliver one `chat_response` to `sub` when the agent finishes the prompt it was just sent. */
  awaitReply(sub: Subscriber, chatId: string | null, correlationId?: string): void {
    const baseline = chatId ? this.options.index.since(chatId, 0)?.total ?? 0 : 0;
    this.replies.set(key(sub), {
      ...sub,
      chatId,
      baseline,
      startedAt: Date.now(),
      idleChecks: 0,
      correlationId,
    });
    this.lastComposerAt = 0;
    this.ensureTimer();
  }

  forgetReply(sub: Subscriber): void {
    this.replies.delete(key(sub));
    this.stopIfIdle();
  }

  /** Background listener (Telegram permission alerts); keeps a slow composer check running. */
  observe(listener: (state: ComposerState) => void): () => void {
    this.observers.add(listener);
    this.ensureTimer();
    return () => {
      this.observers.delete(listener);
      this.stopIfIdle();
    };
  }

  get lastComposerState(): ComposerState | null {
    return this.lastState;
  }

  watchCount(): number {
    return this.watches.size;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watches.clear();
    this.replies.clear();
    this.observers.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
  }

  private stopIfIdle(): void {
    if (this.timer && !this.watches.size && !this.replies.size && !this.observers.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private composerInterval(): number {
    const subs = [...this.watches.values(), ...this.replies.values()];
    if (subs.some((s) => !isRelay(s))) return LOCAL_COMPOSER_MS;
    if (subs.length) return RELAY_COMPOSER_MS;
    return OBSERVER_COMPOSER_MS;
  }

  /** One pass: transcript deltas every tick, composer state at the adaptive interval. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [k, w] of this.watches) if (w.expiresAt <= now) this.watches.delete(k);
      this.stopIfIdle();
      for (const w of this.watches.values()) this.pushDelta(w, now);
      if (!this.watches.size && !this.replies.size && !this.observers.size) return;
      if (now - this.lastComposerAt >= this.composerInterval()) {
        this.lastComposerAt = now;
        const result = await this.options.composerState();
        if (result.ok) {
          this.lastState = result.state;
          this.pushComposer(result.state);
          this.checkReplies(result.state, now);
          for (const o of this.observers) {
            try {
              o(result.state);
            } catch (e) {
              this.options.logError("Composer observer failed", e);
            }
          }
        } else {
          this.checkReplies(null, now);
        }
      }
    } catch (e) {
      this.options.logError("Chat watch tick failed", e);
    } finally {
      this.busy = false;
    }
  }

  private pushDelta(w: Watch, now: number): void {
    if (isRelay(w) && now - w.lastDeltaAt < RELAY_DELTA_MS) return;
    // Re-send from the last known item: it may still have been growing.
    const fromSeq = Math.max(0, w.lastTotal - 1);
    const delta = this.options.index.since(w.chatId, fromSeq);
    if (!delta || delta.mtimeMs === w.mtimeMs) return;
    w.mtimeMs = delta.mtimeMs;
    w.lastTotal = delta.total;
    w.lastDeltaAt = now;
    this.options.send({
      type: "chat_delta",
      clientId: w.clientId,
      targetDeviceId: w.targetDeviceId,
      chatId: w.chatId,
      fromSeq,
      total: delta.total,
      items: delta.items,
    });
  }

  /** A pending approval only goes to watchers of the chat it belongs to. */
  private pushComposer(state: ComposerState): void {
    const scoped = { ...state, pending: null };
    for (const w of this.watches.values()) {
      const view = state.chatId === w.chatId ? state : scoped;
      const body = JSON.stringify(view);
      if (w.lastComposer === body) continue;
      w.lastComposer = body;
      this.options.send({
        type: "composer_state",
        clientId: w.clientId,
        targetDeviceId: w.targetDeviceId,
        chatId: w.chatId,
        state: view,
      });
    }
  }

  private checkReplies(state: ComposerState | null, now: number): void {
    for (const [k, r] of this.replies) {
      if (!r.chatId && state?.chatId) {
        r.chatId = state.chatId;
        r.baseline = 0;
      }
      const latest = r.chatId ? this.options.index.since(r.chatId, r.baseline) : null;
      const answer = latest ? lastAnswer(latest.items) : "";
      const sameChatIdle = state ? !state.running && (!r.chatId || state.chatId === r.chatId) : false;
      r.idleChecks = sameChatIdle && answer && !state?.pending ? r.idleChecks + 1 : 0;
      const timedOut = now - r.startedAt > REPLY_TIMEOUT_MS;
      if (r.idleChecks < REPLY_IDLE_CHECKS && !timedOut) continue;
      this.replies.delete(k);
      this.options.send({
        type: "chat_response",
        clientId: r.clientId,
        targetDeviceId: r.targetDeviceId,
        correlationId: r.correlationId,
        chatId: r.chatId,
        text: answer || "No reply detected after 10 minutes. The agent may still be working — check the chat in Cursor.",
        timestamp: new Date(now).toISOString(),
      });
    }
    this.stopIfIdle();
  }
}

function lastAnswer(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "user") return "";
    if (items[i].role === "assistant" && items[i].text.trim()) return items[i].text;
  }
  return "";
}
