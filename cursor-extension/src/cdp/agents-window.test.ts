import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentsWindow, Evaluator } from "./agents-window";

/** Just enough DOM for the Agents-window page scripts: tags, classes, attributes, descendant selectors. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  clicks = 0;
  isConnected = true;
  constructor(public tag: string, public attrs: Record<string, string> = {}, public text = "") {}

  add(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }

  remove(): void {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
    for (const e of [this, ...this.descendants()]) e.isConnected = false;
  }

  get innerText(): string {
    return [this.text, ...this.children.map((c) => c.innerText)].filter(Boolean).join(" ");
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  click(): void {
    this.clicks++;
  }

  focus(): void {}

  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  querySelectorAll(sel: string): El[] {
    return this.descendants().filter((e) => matches(e, sel));
  }

  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  closest(sel: string): El | null {
    for (let n: El | null = this; n; n = n.parentElement) if (matches(n, sel)) return n;
    return null;
  }
}

function splitTop(sel: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === sep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function matchesCompound(el: El, compound: string): boolean {
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:([\^*]?=)(["']?)(.*?)\5)?\]|:not\(\.([\w-]+)\)/g;
  const classes = (el.attrs.class || "").split(/\s+/);
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(compound))) {
    consumed += m[0].length;
    if (m[1] && el.tag !== m[1]) return false;
    if (m[2] && !classes.includes(m[2])) return false;
    if (m[3]) {
      const v = el.attrs[m[3]];
      if (v === undefined) return false;
      if (m[4] === "=" && v !== m[6]) return false;
      if (m[4] === "^=" && !v.startsWith(m[6])) return false;
      if (m[4] === "*=" && !v.includes(m[6])) return false;
    }
    if (m[7] && classes.includes(m[7])) return false;
  }
  return consumed === compound.length;
}

function matches(el: El, selectorList: string): boolean {
  return splitTop(selectorList, ",").some((sel) => {
    const parts = splitTop(sel, " ");
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let n = el.parentElement; n && i >= 0; n = n.parentElement) if (matchesCompound(n, parts[i])) i--;
    return i < 0;
  });
}

function card(command: string): { root: El; run: El; skip: El } {
  const run = new El("button", {}, "Run");
  const skip = new El("button", {}, "Skip");
  const root = new El("div", { class: "agent-transcript-row" }).add(
    new El("pre", {}, command),
    new El("div").add(skip, run)
  );
  return { root, run, skip };
}

describe("AgentsWindow approve/reject", () => {
  let older: ReturnType<typeof card>;
  let newer: ReturnType<typeof card>;
  let agents: AgentsWindow;

  beforeEach(() => {
    older = card("rm -rf build");
    newer = card("npm test");
    const doc = new El("#document").add(
      new El("ul").add(
        new El("li", { "data-sidebar-item-key": "row:chat-aaaa-1111" }).add(
          new El("button", { "data-sidebar-menu-button": "", "data-active": "true" }, "Chat A")
        )
      ),
      older.root,
      newer.root,
      new El("div", { class: "agent-panel-followup-input" })
    );
    (globalThis as any).document = doc;
    const page: Evaluator = {
      evaluate: async <T>(expression: string) => (0, eval)(expression) as T,
      send: async () => undefined,
    };
    agents = new AgentsWindow(() => page);
  });

  afterEach(() => {
    delete (globalThis as any).document;
  });

  async function pendingId(): Promise<string> {
    const s = await agents.composerState();
    assert.ok(s.ok && s.state.pending);
    return s.state.pending.id;
  }

  it("binds the pending request to the newest card", async () => {
    const s = await agents.composerState();
    assert.ok(s.ok);
    assert.equal(s.state.chatId, "chat-aaaa-1111");
    assert.equal(s.state.pending?.command, "npm test");
    assert.equal(s.state.pending?.approveLabel, "Run");
  });

  it("approve clicks only that card's button even when an older card has the same labels", async () => {
    const r = await agents.resolve(await pendingId(), true);
    assert.equal(r.ok, true);
    assert.equal(newer.run.clicks, 1);
    assert.equal(older.run.clicks, 0);
    assert.equal(newer.skip.clicks + older.skip.clicks, 0);
  });

  it("reject clicks only that card's reject button", async () => {
    const r = await agents.resolve(await pendingId(), false);
    assert.equal(r.ok, true);
    assert.equal(newer.skip.clicks, 1);
    assert.equal(older.skip.clicks + older.run.clicks + newer.run.clicks, 0);
  });

  it("refuses and clicks nothing when the request changed", async () => {
    const id = await pendingId();
    newer.root.remove();
    const r = await agents.resolve(id, true);
    assert.equal(r.ok, false);
    assert.match(String(!r.ok && r.error), /changed/);
    assert.equal(older.run.clicks + newer.run.clicks, 0);
    assert.equal((await agents.resolve("req-zzzz", true)).ok, false);
    assert.equal(older.run.clicks, 0);
  });
});

const FAST = { pollMs: 1, acceptMs: 20, newChatMs: 20 };

describe("AgentsWindow sendPrompt", () => {
  /** A composer that clears when Cursor takes the prompt, from Enter or from the send button. */
  function composer(opts: { enterSubmits: boolean; buttonSubmits: boolean; draft?: string; runsAfterEnter?: boolean; clearsAfterPolls?: number }) {
    const log: string[] = [];
    let text = opts.draft ?? "";
    let running = false;
    let pollsLeft = -1;
    const page: Evaluator = {
      evaluate: async <T>(expression: string) => {
        if (expression.includes("function pageFocusEditor")) {
          return (text.trim() ? { ok: false, error: "already has a draft" } : { ok: true }) as T;
        }
        if (expression.includes("function pageEditorText")) {
          if (pollsLeft > 0 && --pollsLeft === 0) text = "";
          return { ok: true, text, running } as T;
        }
        if (expression.includes("function pageSubmit")) {
          log.push("button");
          if (running) return { ok: false, error: "Send button not available" } as T;
          if (opts.buttonSubmits) text = "";
          return { ok: true } as T;
        }
        throw new Error("unexpected script");
      },
      send: async (method: string, params?: any) => {
        if (method === "Input.insertText") text += params.text;
        if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
          log.push("enter");
          if (opts.enterSubmits) text = "";
          if (opts.runsAfterEnter) running = true;
          if (opts.clearsAfterPolls) pollsLeft = opts.clearsAfterPolls;
        }
        return undefined;
      },
    };
    return { agents: new AgentsWindow(() => page, FAST), log, typed: () => text };
  }

  it("presses Enter and stops once the composer empties", async () => {
    const { agents, log } = composer({ enterSubmits: true, buttonSubmits: true });
    assert.deepEqual(await agents.sendPrompt("run the tests"), { ok: true });
    assert.deepEqual(log, ["enter"]);
  });

  it("falls back to the send button when Enter is ignored", async () => {
    const { agents, log } = composer({ enterSubmits: false, buttonSubmits: true });
    assert.deepEqual(await agents.sendPrompt("run the tests"), { ok: true });
    assert.deepEqual(log, ["enter", "button"]);
  });

  it("reports failure when Cursor keeps the prompt", async () => {
    const { agents } = composer({ enterSubmits: false, buttonSubmits: false });
    const r = await agents.sendPrompt("run the tests");
    assert.equal(r.ok, false);
    assert.match(String(!r.ok && r.error), /did not accept/);
  });

  it("waits for a slow composer instead of clicking send", async () => {
    const { agents, log } = composer({ enterSubmits: false, buttonSubmits: true, clearsAfterPolls: 8 });
    assert.deepEqual(await agents.sendPrompt("run the tests"), { ok: true });
    assert.deepEqual(log, ["enter"]);
  });

  it("treats a running agent as accepted and never clicks Stop", async () => {
    const { agents, log } = composer({ enterSubmits: false, buttonSubmits: true, runsAfterEnter: true });
    assert.deepEqual(await agents.sendPrompt("run the tests"), { ok: true });
    assert.deepEqual(log, ["enter"]);
  });

  it("refuses to overwrite a draft typed on the Mac", async () => {
    const { agents, log, typed } = composer({ enterSubmits: true, buttonSubmits: true, draft: "my own draft" });
    const r = await agents.sendPrompt("from the phone");
    assert.equal(r.ok, false);
    assert.match(String(!r.ok && r.error), /draft/);
    assert.deepEqual(log, []);
    assert.equal(typed(), "my own draft");
  });
});

describe("AgentsWindow composer drafts (real page scripts)", () => {
  const EDITOR_CLASS = "tiptap ProseMirror ui-prompt-input-editor__input";
  const PLACEHOLDER = "Plan, search, build anything";

  /** Mounts [editor] in a composer and returns a page that runs the real scripts against it. */
  function mount(editor: El) {
    const doc = new El("#document").add(new El("div", { class: "agent-panel-followup-input" }).add(editor));
    (globalThis as any).document = Object.assign(doc, { createRange: () => ({ selectNodeContents() {} }) });
    (globalThis as any).window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
    const line = editor.querySelector("p") ?? editor;
    const page: Evaluator = {
      evaluate: async <T>(expression: string) => (0, eval)(expression) as T,
      send: async (method: string, params?: any) => {
        if (method === "Input.insertText") {
          // Typing replaces the placeholder, as TipTap does.
          if (line !== editor) line.attrs.class = "";
          for (const c of [...line.children]) c.remove();
          line.text = (line.text === PLACEHOLDER ? "" : line.text) + params.text;
        }
        if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") line.text = "";
        return undefined;
      },
    };
    return { agents: new AgentsWindow(() => page, FAST), line };
  }

  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  const placeholderOnly: Array<[string, () => El]> = [
    ["an empty <p><br></p>", () => new El("div", { class: EDITOR_CLASS }).add(new El("p").add(new El("br")))],
    ["a data-placeholder paragraph", () => new El("div", { class: EDITOR_CLASS }).add(
      new El("p", { class: "is-empty is-editor-empty", "data-placeholder": PLACEHOLDER }).add(new El("br")))],
    ["placeholder text leaking into innerText", () => new El("div", { class: EDITOR_CLASS }).add(
      new El("p", { class: "is-empty is-editor-empty", "data-placeholder": PLACEHOLDER }, PLACEHOLDER))],
    ["a placeholder decoration element", () => new El("div", { class: EDITOR_CLASS }).add(
      new El("p").add(new El("span", { class: "ui-prompt-input-placeholder" }, PLACEHOLDER)))],
    ["the editor's own placeholder attribute", () => new El("div", { class: EDITOR_CLASS, "aria-placeholder": PLACEHOLDER }, PLACEHOLDER)],
    ["zero-width and non-breaking spaces", () => new El("div", { class: EDITOR_CLASS }).add(new El("p", {}, "\u200B\u00A0"))],
  ];

  for (const [name, build] of placeholderOnly) {
    it(`sends into a composer showing ${name}`, async () => {
      const { agents } = mount(build());
      assert.deepEqual(await agents.sendPrompt("run the tests"), { ok: true });
    });
  }

  it("refuses when the Mac composer holds typed text, even beside a placeholder attribute", async () => {
    const editor = new El("div", { class: EDITOR_CLASS }).add(new El("p", { "data-placeholder": PLACEHOLDER }, "half-written idea"));
    const { agents, line } = mount(editor);
    const r = await agents.sendPrompt("from the phone");
    assert.equal(r.ok, false);
    assert.match(String(!r.ok && r.error), /already has a draft/);
    assert.equal(line.text, "half-written idea");
  });
});

describe("AgentsWindow lock", () => {
  const chatA = "chat-aaaa-1111";
  const chatB = "chat-bbbb-2222";

  /** A window where switching chats takes a while, so unserialized actions would interleave. */
  function slowWindow() {
    let active = chatA;
    let text = "";
    const delivered: Record<string, string[]> = { [chatA]: [], [chatB]: [] };
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const page: Evaluator = {
      evaluate: async <T>(expression: string) => {
        if (expression.includes("function pageComposer")) {
          return { ok: true, state: { chatId: active, running: false, pending: null } } as T;
        }
        if (expression.includes("function pageOpenChat")) {
          const id = /,"([A-Za-z0-9-]{8,80})","[^"]*"\)$/.exec(expression)![1];
          await tick();
          active = id;
          await tick();
          return { ok: true } as T;
        }
        if (expression.includes("function pageFocusEditor")) return (text ? { ok: false, error: "draft" } : { ok: true }) as T;
        if (expression.includes("function pageEditorText")) {
          await tick();
          return { ok: true, text, running: false } as T;
        }
        throw new Error("unexpected script");
      },
      send: async (method: string, params?: any) => {
        if (method === "Input.insertText") text += params.text;
        if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
          delivered[active].push(text);
          text = "";
        }
        return undefined;
      },
    };
    return { agents: new AgentsWindow(() => page, FAST), delivered };
  }

  it("two concurrent prompts to different chats each land in their own chat", async () => {
    const { agents, delivered } = slowWindow();
    const [a, b] = await Promise.all([
      agents.prompt({ chatId: chatB }, "for B"),
      agents.prompt({ chatId: chatA }, "for A"),
    ]);
    assert.deepEqual(a, { ok: true, chatId: chatB });
    assert.deepEqual(b, { ok: true, chatId: chatA });
    assert.deepEqual(delivered, { [chatA]: ["for A"], [chatB]: ["for B"] });
  });

  it("a failing action does not block the next one", async () => {
    const { agents, delivered } = slowWindow();
    const bad = agents.prompt({ chatId: "bad id!" }, "nope");
    const good = agents.prompt({ chatId: chatB }, "for B");
    assert.equal((await bad).ok, false);
    assert.equal((await good).ok, true);
    assert.deepEqual(delivered[chatB], ["for B"]);
  });
});
