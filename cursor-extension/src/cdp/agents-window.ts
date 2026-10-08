/**
 * AgentsWindow — reads and drives Cursor's "Cursor Agents" window over CDP.
 * Every selector lives in SELECTORS; page scripts are fixed functions serialized with
 * JSON arguments, so nothing a client sends is ever evaluated as code.
 */

/* Page-side globals, only referenced inside serialized page functions. */
declare const document: any;
declare const window: any;
declare const KeyboardEvent: any;

export interface Evaluator {
  evaluate<T = unknown>(expression: string): Promise<T>;
  send(method: "Input.insertText" | "Input.dispatchKeyEvent", params: Record<string, unknown>): Promise<unknown>;
}

export type RowStatus = "running" | "waiting" | "error" | "draft" | "done" | "unknown";

export interface SidebarRow {
  id: string;
  title: string;
  time: string;
  group: string;
  pinned: boolean;
  status: RowStatus;
  unread: boolean;
  active: boolean;
}

export interface SidebarGroup {
  name: string;
  section: "pinned" | "repositories" | "other";
  expanded: boolean;
  hasMore: boolean;
}

export interface PendingRequest {
  id: string;
  chatId: string | null;
  command: string;
  detail: string;
  approveLabel: string;
  rejectLabel: string;
}

export interface ComposerState {
  chatId: string | null;
  title: string;
  model: string;
  mode: string;
  branch: string;
  environment: string;
  contextPercent: number | null;
  running: boolean;
  pending: PendingRequest | null;
  available: { model: boolean; mode: boolean; stop: boolean; prompt: boolean };
}

export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export const SELECTORS = {
  row: '[data-sidebar-item-key^="row:"]',
  rowButton: "[data-sidebar-menu-button]",
  rowLabel: ".ui-sidebar-menu-button-label",
  rowStatus: '.ui-sidebar-menu-button-status-icon [aria-label]',
  section: ".ui-sidebar-section, section",
  sectionHead: ".ui-sidebar-section-head",
  group: ".ui-sidebar-group",
  groupLabel: ".ui-sidebar-group-label",
  more: "[data-sidebar-paginated-menu-toggle]",
  sidebarButton: "[data-sidebar-menu-button]",
  composerRoot: ".agent-panel-followup-input, .ui-prompt-input",
  editor: ".tiptap.ProseMirror.ui-prompt-input-editor__input:not(.composer-human-tiptap-readonly-editor)",
  submit: ".ui-prompt-input-submit-button",
  modelTrigger: ".vscode-model-picker__trigger",
  chatTitle: ".chat-title-tab-trigger",
  modePill: '[aria-label^="Remove "]',
  addMenu: '[aria-label="Add agents, context, tools"]',
  transcript: ".composer-react-virtual-plane-row, .virtualized-composer-messages-row, .agent-transcript-row",
};

export const MODES = ["Agent", "Ask", "Plan", "Debug", "Multitask"];
const CHAT_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

function call(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
}

/* ---------- page functions (run inside Cursor; must be self-contained) ---------- */

function pageSidebar(S: typeof SELECTORS) {
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const statusOf = (label: string): string => {
    const l = label.toLowerCase();
    if (/running|generating|in progress|working|thinking/.test(l)) return "running";
    if (/waiting|needs|approval|permission|input|attention|review/.test(l)) return "waiting";
    if (/error|failed/.test(l)) return "error";
    if (/draft/.test(l)) return "draft";
    if (/completed|done|finished|idle/.test(l)) return "done";
    return "unknown";
  };
  const groupOf = (el: any) => {
    const g = el.closest(S.group);
    return clean(g && g.querySelector(S.groupLabel) && g.querySelector(S.groupLabel).innerText);
  };
  const sectionHeadOf = (el: any) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const head = n.querySelector(":scope > " + S.sectionHead + ", :scope > * > " + S.sectionHead);
      if (head && !head.contains(el)) return head;
      n = n.parentElement;
    }
    return null;
  };
  const rows: any[] = [];
  const seen = new Set();
  for (const li of document.querySelectorAll(S.row)) {
    const id = String(li.getAttribute("data-sidebar-item-key") || "").slice(4);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const btn = li.querySelector(S.rowButton) || li;
    const label = clean((li.querySelector(S.rowLabel) || {}).innerText);
    const statusEl = li.querySelector(S.rowStatus);
    const statusLabel = clean(statusEl && (statusEl.getAttribute("aria-label") || ""));
    const full = clean(btn.innerText);
    const time = label && full.startsWith(label) ? clean(full.slice(label.length)).split(" ")[0] : "";
    const groupLabel = groupOf(li);
    const pinned = /^pinned$/i.test(groupLabel);
    const head = pinned ? null : sectionHeadOf(li);
    rows.push({
      id,
      title: label || full,
      time,
      group: pinned ? "Pinned" : clean(head && head.innerText) || groupLabel || "Chats",
      pinned,
      status: statusOf(statusLabel),
      unread: btn.getAttribute("data-unread") === "true" || /unread/i.test(statusLabel),
      active: btn.getAttribute("data-active") === "true",
    });
  }
  const groups: any[] = [];
  for (const head of document.querySelectorAll(S.sectionHead)) {
    const name = clean(head.innerText);
    if (!name) continue;
    const label = groupOf(head);
    let container = head.parentElement;
    while (container && container !== document.body && !container.querySelector(S.row) && !container.querySelector(S.more)) {
      container = container.parentElement;
    }
    groups.push({
      name,
      section: /pinned/i.test(label) ? "pinned" : /repositor/i.test(label) ? "repositories" : "other",
      expanded: head.getAttribute("aria-expanded") !== "false",
      hasMore: !!(head.parentElement && head.parentElement.parentElement && head.parentElement.parentElement.querySelector(S.more)),
    });
  }
  return { ok: true, rows, groups };
}

/**
 * The newest approve/reject pair outside the sidebar, with the exact button elements.
 * Shared by pageComposer and pageResolve so a resolve clicks the card whose ID it checked.
 */
export function pagePending(S: typeof SELECTORS) {
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  };
  const root = document.querySelector(S.composerRoot);
  const activeRow = document.querySelector(S.row + ' [data-active="true"]');
  const activeLi = activeRow && activeRow.closest(S.row);
  const chatId: string | null = activeLi ? String(activeLi.getAttribute("data-sidebar-item-key")).slice(4) : null;

  const approveRe = /^(run|accept|allow|approve|continue|yes|run command|accept and run|allow once)\b/i;
  const rejectRe = /^(skip|reject|deny|cancel|no|don't allow|decline)\b/i;
  const scope = Array.from(document.querySelectorAll(S.transcript)).concat(root ? [root] : []) as any[];
  const candidates: any[] = [];
  for (const area of scope) {
    for (const b of area.querySelectorAll("button, [role='button']")) {
      if (b.closest("[data-sidebar-item-key]") || candidates.includes(b)) continue;
      const t = clean(b.innerText || b.getAttribute("aria-label")).replace(/[⏎↵⌘⇧]+.*$/, "").trim();
      if (approveRe.test(t)) candidates.push(b);
    }
  }
  for (const ok of candidates.reverse()) {
    let box = ok.parentElement;
    let reject: any = null;
    for (let depth = 0; box && depth < 6 && !reject; depth++, box = box.parentElement) {
      reject = Array.from(box.querySelectorAll("button, [role='button']")).find((b: any) =>
        b !== ok && rejectRe.test(clean(b.innerText || b.getAttribute("aria-label")))) || null;
      if (reject) break;
    }
    if (!reject || !box) continue;
    let card = box;
    for (let depth = 0; card.parentElement && depth < 4 && !card.querySelector("pre, code"); depth++) card = card.parentElement;
    const codeEl = card.querySelector("pre, code");
    const command = clean(codeEl ? codeEl.innerText : "").slice(0, 2000);
    const detail = clean(card.innerText).slice(0, 600);
    const approveLabel = clean(ok.innerText || ok.getAttribute("aria-label")).slice(0, 40);
    const rejectLabel = clean(reject.innerText || reject.getAttribute("aria-label")).slice(0, 40);
    const id = "req-" + hash([chatId, command || detail, approveLabel, rejectLabel].join("\u0000"));
    return { chatId, pending: { id, chatId, command, detail, approveLabel, rejectLabel }, approveEl: ok, rejectEl: reject };
  }
  return { chatId, pending: null, approveEl: null, rejectEl: null };
}

function pageComposer(S: typeof SELECTORS, findPending: typeof pagePending) {
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const root = document.querySelector(S.composerRoot);
  const editor = document.querySelector(S.editor);
  const submit = root ? root.querySelector(S.submit) : document.querySelector(S.submit);
  const { chatId, pending } = findPending(S);
  const buttons = root ? Array.from(root.querySelectorAll("button, [role='button']")) as any[] : [];
  const ariaStarting = (prefix: string) => buttons.find((b) => String(b.getAttribute("aria-label") || "").startsWith(prefix));
  const modelBtn = root && root.querySelector(S.modelTrigger);
  const pill = root && root.querySelector(S.modePill);
  const branchBtn = ariaStarting("Branch ");
  const envBtn = buttons.find((b) => / environment$/.test(String(b.getAttribute("aria-label") || "")));
  const ctxBtn = ariaStarting("Context ");
  const ctx = ctxBtn ? String(ctxBtn.getAttribute("aria-label")).match(/(\d+)%/) : null;
  const submitLabel = String((submit && submit.getAttribute("aria-label")) || "");
  const titleEl = document.querySelector(S.chatTitle);

  return {
    ok: true,
    state: {
      chatId,
      title: clean(titleEl && titleEl.innerText).replace(/^Chat title\.\s*/i, ""),
      model: clean(modelBtn && modelBtn.innerText),
      mode: pill ? String(pill.getAttribute("aria-label")).replace(/^Remove /, "") : "Agent",
      branch: branchBtn ? clean(branchBtn.innerText) : "",
      environment: envBtn ? clean(envBtn.innerText) : "",
      contextPercent: ctx ? Number(ctx[1]) : null,
      running: /stop/i.test(submitLabel),
      pending,
      available: { model: !!modelBtn, mode: !!(root && root.querySelector(S.addMenu)), stop: !!submit, prompt: !!editor },
    },
  };
}

async function pageOpenChat(S: typeof SELECTORS, id: string, group: string) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const find = () => {
    const li = document.querySelector('[data-sidebar-item-key="row:' + id + '"]');
    return li && (li.querySelector(S.rowButton) || li);
  };
  let btn = find();
  if (!btn && group) {
    const head = Array.from(document.querySelectorAll(S.sectionHead)).find((h: any) => clean(h.innerText) === group) as any;
    if (head && head.getAttribute("aria-expanded") === "false") {
      head.click();
      await sleep(300);
      btn = find();
    }
  }
  for (let i = 0; !btn && i < 8; i++) {
    const toggles = Array.from(document.querySelectorAll(S.more)) as any[];
    if (!toggles.length) break;
    for (const t of toggles) t.click();
    await sleep(350);
    btn = find();
  }
  if (!btn) return { ok: false, error: "Chat is not in the Agents sidebar (it may be archived)" };
  btn.click();
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const li = document.querySelector('[data-sidebar-item-key="row:' + id + '"]');
    const b = li && li.querySelector(S.rowButton);
    if (b && b.getAttribute("data-active") === "true") return { ok: true };
  }
  return { ok: false, error: "Clicked the chat but Cursor did not switch to it" };
}

function pageExpandMore(S: typeof SELECTORS) {
  const toggles = Array.from(document.querySelectorAll(S.more)) as any[];
  for (const t of toggles) t.click();
  return { ok: true, clicked: toggles.length };
}

async function pageNewChat(S: typeof SELECTORS) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  // Chat rows share the sidebar button markup, so a chat titled "New chat …" must not match.
  const btn = (Array.from(document.querySelectorAll(S.sidebarButton)) as any[])
    .find((b) => !b.closest(S.row) && /^new (chat|agent)\b/i.test(clean(b.innerText)));
  if (!btn) return { ok: false, error: "New Chat button not found" };
  btn.click();
  await sleep(400);
  return { ok: true };
}

function pageFocusEditor(S: typeof SELECTORS) {
  const editor = document.querySelector(S.editor);
  if (!editor) return { ok: false, error: "Composer not found; open a chat in the Agents window" };
  // Only typed text is a draft: TipTap marks an empty document `is-editor-empty` and shows
  // its placeholder ("Plan, search, build anything") from a data-placeholder attribute or a
  // decoration element, either of which can leak into innerText.
  const clean = (s: any) => String(s || "").replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ").replace(/\s+/g, " ").trim();
  const placeholders = new Set<string>();
  for (const el of [editor, ...Array.from(editor.querySelectorAll("[data-placeholder], [placeholder], [aria-placeholder]")) as any[]]) {
    for (const attr of ["data-placeholder", "placeholder", "aria-placeholder"]) {
      const v = clean(el.getAttribute(attr));
      if (v) placeholders.add(v);
    }
  }
  let typed = clean(editor.innerText);
  for (const el of Array.from(editor.querySelectorAll('[class*="placeholder"]')) as any[]) {
    const t = clean(el.innerText);
    if (t) typed = clean(typed.replace(t, ""));
  }
  const empty = !typed || placeholders.has(typed) ||
    (!!editor.querySelector(".is-editor-empty") && editor.querySelectorAll("p").length <= 1);
  if (!empty) {
    return { ok: false, error: "The Cursor composer on your Mac already has a draft. Send or clear it there, then try again." };
  }
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return { ok: true };
}

function pageEditorText(S: typeof SELECTORS) {
  const editor = document.querySelector(S.editor);
  const root = document.querySelector(S.composerRoot);
  const submit = root ? root.querySelector(S.submit) : null;
  const running = !!submit && /stop/i.test(String(submit.getAttribute("aria-label") || ""));
  return { ok: !!editor, text: editor ? String(editor.innerText || "") : "", running };
}

function pageSubmit(S: typeof SELECTORS) {
  const root = document.querySelector(S.composerRoot);
  const submit = root ? root.querySelector(S.submit) : null;
  if (!submit || submit.disabled || /stop/i.test(String(submit.getAttribute("aria-label") || ""))) {
    return { ok: false, error: "Send button not available" };
  }
  submit.click();
  return { ok: true };
}

function pageStop(S: typeof SELECTORS) {
  const root = document.querySelector(S.composerRoot);
  const submit = root ? root.querySelector(S.submit) : document.querySelector(S.submit);
  if (!submit) return { ok: false, error: "Submit button not found" };
  if (!/stop/i.test(String(submit.getAttribute("aria-label") || ""))) return { ok: false, error: "The agent is not running" };
  submit.click();
  return { ok: true };
}

async function pageSetModel(S: typeof SELECTORS, name: string, listOnly: boolean) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const menus = () => Array.from(document.querySelectorAll('[role="menu"]')) as any[];
  const close = async () => {
    for (let i = 0; i < 4 && menus().length; i++) {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
      await sleep(200);
    }
  };
  const root = document.querySelector(S.composerRoot);
  const trigger = root && root.querySelector(S.modelTrigger);
  if (!trigger) return { ok: false, error: "Model picker not found" };
  trigger.click();
  await sleep(350);
  const modelItem = menus().flatMap((m) => Array.from(m.querySelectorAll('[role="menuitem"]')) as any[]).find((i) => /^Model\b/.test(clean(i.innerText)));
  if (!modelItem) {
    await close();
    return { ok: false, error: "Model submenu not found" };
  }
  const before = new Set(menus());
  modelItem.focus();
  modelItem.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, bubbles: true, cancelable: true }));
  await sleep(450);
  const sub = menus().filter((m) => !before.has(m));
  const items = (sub.length ? Array.from(sub[sub.length - 1].querySelectorAll('[role^="menuitem"]')) : []) as any[];
  const names = items.map((i) => clean(i.innerText).replace(/\s+NEW$/, "")).filter((n) => n && !/^add models$/i.test(n));
  if (listOnly) {
    await close();
    return { ok: true, models: names };
  }
  const want = name.toLowerCase();
  const pick = items.find((i) => clean(i.innerText).replace(/\s+NEW$/, "").toLowerCase() === want)
    || items.find((i) => clean(i.innerText).toLowerCase().startsWith(want));
  if (!pick) {
    await close();
    return { ok: false, error: "Model not offered by Cursor: " + name, models: names };
  }
  pick.click();
  await sleep(300);
  await close();
  return { ok: true, model: clean(trigger.innerText), models: names };
}

async function pageSetMode(S: typeof SELECTORS, mode: string) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const clean = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
  const root = document.querySelector(S.composerRoot);
  if (!root) return { ok: false, error: "Composer not found" };
  const pill = root.querySelector(S.modePill);
  const current = pill ? String(pill.getAttribute("aria-label")).replace(/^Remove /, "") : "Agent";
  if (current.toLowerCase() === mode.toLowerCase()) return { ok: true, mode: current };
  if (pill) {
    pill.click();
    await sleep(250);
  }
  if (mode.toLowerCase() === "agent") return { ok: true, mode: "Agent" };
  const add = root.querySelector(S.addMenu);
  if (!add) return { ok: false, error: "Mode menu not found" };
  add.click();
  await sleep(350);
  const option = (Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')) as any[])
    .find((o) => clean(o.innerText).toLowerCase().startsWith(mode.toLowerCase() + " ") || clean(o.innerText).toLowerCase() === mode.toLowerCase());
  if (!option) {
    for (let i = 0; i < 4 && document.querySelector('[role="listbox"], [role="menu"]'); i++) {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
      await sleep(200);
    }
    return { ok: false, error: "Mode not offered by Cursor: " + mode };
  }
  option.click();
  await sleep(250);
  const after = root.querySelector(S.modePill);
  return { ok: true, mode: after ? String(after.getAttribute("aria-label")).replace(/^Remove /, "") : mode };
}

/** Clicks approve or reject on the very card whose request ID still matches; never searches by label. */
export function pageResolve(S: typeof SELECTORS, requestId: string, approve: boolean, findPending: typeof pagePending) {
  const found = findPending(S);
  const p = found.pending;
  if (!p) return { ok: false, error: "No pending request in the open chat" };
  if (p.id !== requestId) return { ok: false, error: "The request changed — review it again", pending: p };
  const btn = approve ? found.approveEl : found.rejectEl;
  if (!btn || btn.isConnected === false) return { ok: false, error: "The request's button disappeared — review it again" };
  btn.click();
  return { ok: true, label: approve ? p.approveLabel : p.rejectLabel, command: p.command };
}

/* ---------- controller ---------- */

export interface Timing {
  /** Delay between checks while waiting for Cursor. */
  pollMs: number;
  /** How long Cursor gets to take a prompt (composer empties or starts running). */
  acceptMs: number;
  /** How long a new chat gets to show its ID after its first prompt. */
  newChatMs: number;
}

const DEFAULT_TIMING: Timing = { pollMs: 150, acceptMs: 3000, newChatMs: 3000 };

export interface PromptTarget {
  chatId?: string;
  group?: string;
  newChat?: boolean;
}

export class AgentsWindow {
  /** Every action that changes the open chat or clicks in it runs one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly page: () => Evaluator | null, private readonly timing: Timing = DEFAULT_TIMING) {}

  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run<T>(expression: string): Promise<T | { ok: false; error: string }> {
    const page = this.page();
    if (!page) return { ok: false, error: "Cursor Agents window is not attached (open it in Cursor)" };
    try {
      const result = await page.evaluate<T>(expression);
      return result ?? { ok: false, error: "No result from Cursor" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private sleep(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.timing.pollMs));
  }

  get attached(): boolean {
    return !!this.page();
  }

  sidebar(): Promise<ActionResult<{ rows: SidebarRow[]; groups: SidebarGroup[] }>> {
    return this.run(call(pageSidebar, SELECTORS));
  }

  expandMore(): Promise<ActionResult<{ clicked: number }>> {
    return this.run(call(pageExpandMore, SELECTORS));
  }

  async composerState(): Promise<ActionResult<{ state: ComposerState }>> {
    return this.run(`(${pageComposer.toString()})(${JSON.stringify(SELECTORS)}, ${pagePending.toString()})`);
  }

  private openChatNow(chatId: string, group = ""): Promise<ActionResult> {
    if (!CHAT_ID_RE.test(chatId)) return Promise.resolve({ ok: false, error: "Invalid chat ID" });
    return this.run(call(pageOpenChat, SELECTORS, chatId, String(group).slice(0, 200)));
  }

  /** Opens the chat unless it is already the active one. */
  private async ensureChatNow(chatId: string | undefined, group?: string): Promise<ActionResult> {
    if (!chatId) return { ok: true };
    const state = await this.composerState();
    if (state.ok && state.state.chatId === chatId) return { ok: true };
    return this.openChatNow(chatId, group);
  }

  /** Runs [action] with [chatId] open, without another action switching chats in between. */
  private inChat<T extends ActionResult<any>>(chatId: string | undefined, group: string | undefined, action: () => Promise<T>): Promise<T | ActionResult> {
    return this.locked(async () => {
      const opened = await this.ensureChatNow(chatId, group);
      return opened.ok ? action() : opened;
    });
  }

  openChat(chatId: string, group = ""): Promise<ActionResult> {
    return this.locked(() => this.openChatNow(chatId, group));
  }

  ensureChat(chatId: string | undefined, group?: string): Promise<ActionResult> {
    return this.locked(() => this.ensureChatNow(chatId, group));
  }

  newChat(): Promise<ActionResult> {
    return this.locked(() => this.run(call(pageNewChat, SELECTORS)));
  }

  stop(chatId?: string, group?: string): Promise<ActionResult> {
    return this.inChat(chatId, group, () => this.run(call(pageStop, SELECTORS)));
  }

  listModels(): Promise<ActionResult<{ models: string[] }>> {
    return this.locked(() => this.run(call(pageSetModel, SELECTORS, "", true)));
  }

  setModel(name: string, chatId?: string, group?: string): Promise<ActionResult<{ model: string; models: string[] }> | ActionResult> {
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) return Promise.resolve({ ok: false, error: "Model name required" });
    return this.inChat(chatId, group, () => this.run<ActionResult<{ model: string; models: string[] }>>(call(pageSetModel, SELECTORS, clean, false)));
  }

  setMode(mode: string, chatId?: string, group?: string): Promise<ActionResult<{ mode: string }> | ActionResult> {
    const want = MODES.find((m) => m.toLowerCase() === String(mode || "").trim().toLowerCase());
    if (!want) return Promise.resolve({ ok: false, error: `Mode must be one of ${MODES.join(", ")}` });
    return this.inChat(chatId, group, () => this.run<ActionResult<{ mode: string }>>(call(pageSetMode, SELECTORS, want)));
  }

  /**
   * Opens the target chat (or a new one), types the prompt, presses Enter and confirms Cursor
   * took it, as one step no other action can interleave with. [beforeSend] runs just before
   * typing, with the chat that was open before New Chat.
   */
  prompt(target: PromptTarget, text: string, beforeSend?: (previousChatId: string | null) => void):
    Promise<ActionResult<{ chatId: string | null }>> {
    return this.locked(async () => {
      let previousChatId: string | null = null;
      if (target.newChat) {
        const before = await this.composerState();
        previousChatId = before.ok ? before.state.chatId : null;
      }
      const opened = target.newChat ? await this.run<ActionResult>(call(pageNewChat, SELECTORS))
        : await this.ensureChatNow(target.chatId, target.group);
      if (!opened.ok) return opened;
      beforeSend?.(previousChatId);
      const sent = await this.sendPromptNow(text);
      if (!sent.ok) return sent;
      const chatId = target.newChat ? await this.newChatId(previousChatId) : target.chatId ?? null;
      return { ok: true, chatId };
    });
  }

  /** Types into whatever chat is open; prefer prompt(), which also opens the chat under the lock. */
  sendPrompt(text: string): Promise<ActionResult> {
    return this.locked(() => this.sendPromptNow(text));
  }

  /**
   * Types into the composer with trusted input events, checks it landed, presses Enter, and
   * confirms Cursor took it (the composer empties or starts running); falls back to the send
   * button once, and never while the agent is running.
   */
  private async sendPromptNow(text: string): Promise<ActionResult> {
    const page = this.page();
    if (!page) return { ok: false, error: "Cursor Agents window is not attached (open it in Cursor)" };
    const focus = await this.run<ActionResult>(call(pageFocusEditor, SELECTORS));
    if (!focus.ok) return focus;
    const probe = text.trim().slice(0, 40).replace(/\s+/g, " ");
    const read = async () => {
      const r = await this.run<{ ok: boolean; text: string; running?: boolean }>(call(pageEditorText, SELECTORS));
      const typed = !!r.ok && "text" in r && r.text.replace(/\s+/g, " ").includes(probe);
      return { typed, running: !!r.ok && "running" in r && r.running === true };
    };
    const accepted = async () => {
      const deadline = Date.now() + this.timing.acceptMs;
      do {
        await this.sleep();
        const s = await read();
        if (!s.typed || s.running) return true;
      } while (Date.now() < deadline);
      return false;
    };
    try {
      await page.send("Input.insertText", { text });
      if (!(await read()).typed) return { ok: false, error: "Text did not reach the Cursor composer" };
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      if (await accepted()) return { ok: true };
      const clicked = await this.run<ActionResult>(call(pageSubmit, SELECTORS));
      if (clicked.ok && (await accepted())) return { ok: true };
      return { ok: false, error: "Cursor did not accept the prompt; it is still in the composer on your Mac" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async newChatId(previousChatId: string | null): Promise<string | null> {
    const deadline = Date.now() + this.timing.newChatMs;
    do {
      const state = await this.composerState();
      if (state.ok && state.state.chatId && state.state.chatId !== previousChatId) return state.state.chatId;
      await this.sleep();
    } while (Date.now() < deadline);
    return null;
  }

  /**
   * Approves or rejects [requestId], only while [chatId] is still the open chat; the check
   * and the click run under the lock so no prompt can switch chats in between.
   */
  resolve(requestId: string, approve: boolean, chatId?: string):
    Promise<ActionResult<{ label: string; command: string }> & { pending?: PendingRequest }> {
    if (!/^req-[a-z0-9]{1,16}$/.test(String(requestId || ""))) {
      return Promise.resolve({ ok: false, error: "A request ID from the pending prompt is required" });
    }
    return this.locked(async () => {
      if (chatId !== undefined) {
        const state = await this.composerState();
        if (!state.ok) return state;
        if (state.state.chatId !== chatId) return { ok: false as const, error: CHAT_CHANGED };
      }
      const expression = `(${pageResolve.toString()})(${JSON.stringify(SELECTORS)}, ${JSON.stringify(requestId)}, ${approve}, ${pagePending.toString()})`;
      return this.run<ActionResult<{ label: string; command: string }> & { pending?: PendingRequest }>(expression);
    });
  }
}

export const CHAT_CHANGED = "That chat is no longer open in Cursor — review the request again";
