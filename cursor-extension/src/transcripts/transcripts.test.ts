import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { TranscriptIndex, parseTranscript, cleanUserText } from "./transcript-index";
import { WorkspaceDiff, containedRelative, diffFromSnippets } from "./workspace-diff";
import { ChatWatcher } from "../chat-watcher";

const CHAT_A = "aaaaaaaa-1111-2222-3333-444444444444";
const CHAT_B = "bbbbbbbb-1111-2222-3333-444444444444";

const user = (text: string) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const say = (...content: unknown[]) => JSON.stringify({ role: "assistant", message: { content } });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string, input: unknown) => ({ type: "tool_use", name, input });

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-transcripts-"));
}

function writeChat(root: string, project: string, id: string, lines: string[]): string {
  const dir = path.join(root, project, "agent-transcripts", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("transcripts become user messages, one work group per turn, and the final answer", () => {
  const content = [
    user("<timestamp>Tuesday, Oct 6, 2026, 2:40 PM (UTC+5:30)</timestamp>\n<user_query>Fix the login bug</user_query>"),
    say(text("Looking at the code."), tool("Read", { path: "/r/a.ts" }), tool("Grep", { pattern: "x" })),
    say(tool("StrReplace", { path: "/r/a.ts", old_string: "a\nb", new_string: "c" }), tool("Shell", { command: "npm test" })),
    say(text("Fixed: the token was not refreshed.")),
    JSON.stringify({ type: "turn_ended" }),
    user("<user_query>Thanks</user_query>"),
    say(text("You're welcome.")),
  ].join("\n");
  const { items, filesChanged } = parseTranscript(CHAT_A, content);
  assert.deepEqual(items.map((i) => i.role), ["user", "work", "assistant", "user", "assistant"]);
  assert.deepEqual(items.map((i) => i.seq), [0, 1, 2, 3, 4]);
  assert.equal(items[0].text, "Fix the login bug");
  assert.equal(items[0].timestamp, "2026-10-06T09:10:00.000Z");
  const work = items[1].work!;
  assert.equal(work.summary, "Edited 1 file, ran 1 command, read 1 file, searched 1 time");
  assert.deepEqual(work.edits, [{ path: "/r/a.ts", kind: "modified", added: 1, removed: 2 }]);
  assert.deepEqual(work.commands, ["npm test"]);
  assert.deepEqual(work.notes, ["Looking at the code."]);
  assert.equal(items[2].text, "Fixed: the token was not refreshed.");
  assert.deepEqual(filesChanged, [{ path: "/r/a.ts", kind: "modified", added: 1, removed: 2 }]);
  assert.equal(cleanUserText("<system_reminder>secret context</system_reminder>hello"), "hello");
});

test("the transcript index lists, pages and follows chats without escaping its root", () => {
  const root = tmp();
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(user(`<user_query>question ${i}</user_query>`), say(text(`answer ${i}`)));
  writeChat(root, "Users-me-proj", CHAT_A, lines);
  writeChat(root, "Users-me-other", CHAT_B, [user("<user_query>other chat</user_query>")]);
  const index = new TranscriptIndex(root);

  const listed = index.list();
  assert.equal(listed.total, 2);
  assert.equal(index.summary(CHAT_A)?.title, "question 0");
  assert.equal(index.list({ query: "other" }).chats[0].id, CHAT_B);

  const latest = index.get(CHAT_A, { limit: 4 })!;
  assert.equal(latest.total, 10);
  assert.deepEqual(latest.items.map((i) => i.seq), [6, 7, 8, 9]);
  assert.equal(latest.hasOlder, true);
  const older = index.get(CHAT_A, { before: 6, limit: 4 })!;
  assert.deepEqual(older.items.map((i) => i.seq), [2, 3, 4, 5]);
  assert.deepEqual(index.since(CHAT_A, 9)!.items.map((i) => i.text), ["answer 4"]);

  for (const bad of ["../" + CHAT_A, "short", CHAT_A + "/../x", "..%2f"]) {
    assert.equal(index.findFile(bad), null, bad);
    assert.equal(index.get(bad), null, bad);
  }
});

test("file paths for diffs must stay inside the chat's repository", () => {
  const repo = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "x");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  fs.symlinkSync(outside, path.join(repo, "link"));

  assert.equal(containedRelative(repo, "src/a.ts"), "src/a.ts");
  assert.equal(containedRelative(repo, path.join(repo, "src", "a.ts")), "src/a.ts");
  for (const bad of ["../x", "/etc/passwd", path.join(outside, "secret.txt"), "link/secret.txt", "", "a\0b"]) {
    assert.equal(containedRelative(repo, bad), null, bad);
  }
});

test("git diffs are read-only, contained, and fall back to transcript snippets", async () => {
  const repo = tmp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "fresh\n");

  const calls: string[][] = [];
  const diff = new WorkspaceDiff(async (cwd, args) => {
    calls.push(args);
    try {
      return { stdout: execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString(), code: 0 };
    } catch (e: any) {
      if (e.status === 1) return { stdout: String(e.stdout), code: 1 };
      throw e;
    }
  });
  const changed = await diff.fileDiff(repo, "a.txt");
  assert.ok(changed && "diff" in changed && changed.diff.includes("-one") && changed.diff.includes("+two"));
  const added = await diff.fileDiff(repo, "new.txt");
  assert.ok(added && "diff" in added && added.diff.includes("+fresh"));
  assert.deepEqual(await diff.fileDiff(repo, "../outside.txt"), { error: "File is outside the chat's repository" });
  assert.equal(await diff.fileDiff(tmp(), "a.txt"), null);
  for (const args of calls.filter((a) => a[0] === "diff")) {
    assert.ok(args.includes("--no-ext-diff") && args.includes("--no-textconv"), args.join(" "));
  }
  const stats = await diff.stats(repo);
  assert.deepEqual(stats?.map((s) => [s.path, s.kind]).sort(), [["a.txt", "modified"], ["new.txt", "added"]]);

  const fallback = diffFromSnippets("a.ts", [{ tool: "StrReplace", before: "old", after: "new" }]);
  assert.equal(fallback.source, "transcript");
  assert.match(fallback.diff, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -1,1 \+1,1 @@ StrReplace\n-old\n\+new$/);
});

test("chat watches are isolated per subscriber and lapse unless renewed", async () => {
  const totals: Record<string, number> = { [CHAT_A]: 3, [CHAT_B]: 1 };
  const mtimes: Record<string, number> = { [CHAT_A]: 1, [CHAT_B]: 1 };
  const index = {
    since: (chatId: string, from: number) => ({
      total: totals[chatId],
      mtimeMs: mtimes[chatId],
      items: Array.from({ length: totals[chatId] }, (_, seq) => ({ seq, id: `${chatId}:${seq}`, role: "assistant", text: `${chatId}-${seq}` })).slice(from),
    }),
  };
  const sent: any[] = [];
  const watcher = new ChatWatcher({
    index: index as any,
    composerState: async () => ({ ok: false, error: "not attached" }),
    send: (p) => sent.push(p),
    logError: () => {},
    tickMs: 60_000,
  });
  const phone = { clientId: "relay:S1", targetDeviceId: "phone" };
  const laptop = { clientId: "local-1" };
  const t0 = 1_000_000;
  watcher.watch(phone, CHAT_A, 3, t0);
  watcher.watch(laptop, CHAT_B, 0, t0);
  await watcher.tick(t0 + 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clientId, "local-1");
  assert.equal(sent[0].chatId, CHAT_B);

  sent.length = 0;
  totals[CHAT_A] = 4;
  mtimes[CHAT_A] = 2;
  await watcher.tick(t0 + 2);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].clientId, sent[0].targetDeviceId, sent[0].chatId, sent[0].fromSeq], ["relay:S1", "phone", CHAT_A, 2]);
  assert.ok(sent[0].items.every((i: any) => i.text.startsWith(CHAT_A)));

  // A new watch from the same subscriber replaces the old one.
  watcher.watch(phone, CHAT_B, 1, t0 + 3);
  assert.equal(watcher.watchCount(), 2);

  // Renewal keeps the phone's watch; the laptop's lapses after 10 minutes.
  watcher.watch(phone, CHAT_B, 1, t0 + 9 * 60_000);
  await watcher.tick(t0 + 10 * 60_000 + 5);
  assert.equal(watcher.watchCount(), 1);
  watcher.forgetClient("relay:S1");
  assert.equal(watcher.watchCount(), 0);
  watcher.dispose();
});

test("relay deltas are coalesced and a pending approval only reaches watchers of its chat", async () => {
  let total = 1;
  let mtime = 1;
  const index = {
    since: (_chatId: string, from: number) => ({
      total,
      mtimeMs: mtime,
      items: Array.from({ length: total }, (_, seq) => ({ seq, id: `x:${seq}`, role: "assistant", text: `t${seq}` })).slice(from),
    }),
  };
  const pending = { id: "req-abc", chatId: CHAT_A, command: "npm test", detail: "", approveLabel: "Run", rejectLabel: "Skip" };
  const state = {
    chatId: CHAT_A, title: "A", model: "m", mode: "Agent", branch: "", environment: "",
    contextPercent: null, running: false, pending,
    available: { model: true, mode: true, stop: true, prompt: true },
  };
  const sent: any[] = [];
  const watcher = new ChatWatcher({
    index: index as any,
    composerState: async () => ({ ok: true, state }),
    send: (p) => sent.push(p),
    logError: () => {},
    tickMs: 60_000,
  });
  const t0 = 2_000_000;
  watcher.watch({ clientId: "relay:S1", targetDeviceId: "phone" }, CHAT_A, 1, t0);
  watcher.watch({ clientId: "local-1" }, CHAT_B, 1, t0);
  await watcher.tick(t0);
  const composer = sent.filter((p) => p.type === "composer_state");
  assert.equal(composer.find((p) => p.chatId === CHAT_A).state.pending.id, "req-abc");
  assert.equal(composer.find((p) => p.chatId === CHAT_B).state.pending, null);

  const relayDeltas = () => sent.filter((p) => p.type === "chat_delta" && p.clientId === "relay:S1").length;
  sent.length = 0;
  for (let i = 1; i <= 8; i++) {
    total++;
    mtime++;
    await watcher.tick(t0 + i * 1000);
  }
  // Eight seconds of a growing transcript: at most one relay push every 4 s, every tick locally.
  assert.equal(relayDeltas(), 2);
  assert.equal(sent.filter((p) => p.type === "chat_delta" && p.clientId === "local-1").length, 8);
  // Nothing is lost: the next allowed push carries everything since the last one.
  await watcher.tick(t0 + 9000);
  const last = sent.filter((p) => p.type === "chat_delta" && p.clientId === "relay:S1").pop();
  assert.equal(last.total, total);
  assert.equal(last.fromSeq, 5);
  watcher.dispose();
});
