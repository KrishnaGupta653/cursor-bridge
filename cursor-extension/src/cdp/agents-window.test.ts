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
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:(\^?=)(["']?)(.*?)\5)?\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(compound))) {
    consumed += m[0].length;
    if (m[1] && el.tag !== m[1]) return false;
    if (m[2] && !(el.attrs.class || "").split(/\s+/).includes(m[2])) return false;
    if (m[3]) {
      const v = el.attrs[m[3]];
      if (v === undefined) return false;
      if (m[4] === "=" && v !== m[6]) return false;
      if (m[4] === "^=" && !v.startsWith(m[6])) return false;
    }
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
