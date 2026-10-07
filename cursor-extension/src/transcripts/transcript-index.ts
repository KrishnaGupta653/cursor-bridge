/**
 * TranscriptIndex — read-only view of Cursor Agent transcripts on disk.
 * Layout: ~/.cursor/projects/<project>/agent-transcripts/<chatId>/<chatId>.jsonl
 * The chat ID matches the Agents window sidebar row key (row:<chatId>).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ChatSummary {
  id: string;
  title: string;
  project: string;
  repoPath: string | null;
  repoName: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEdit {
  path: string;
  kind: "added" | "modified" | "deleted";
  added: number;
  removed: number;
}

export interface WorkSummary {
  summary: string;
  edits: FileEdit[];
  commands: string[];
  reads: number;
  searches: number;
  other: number;
  notes: string[];
}

export interface ChatItem {
  seq: number;
  id: string;
  role: "user" | "assistant" | "work";
  text: string;
  timestamp?: string;
  work?: WorkSummary;
}

export interface ChatPage {
  chat: ChatSummary;
  items: ChatItem[];
  total: number;
  hasOlder: boolean;
  filesChanged: FileEdit[];
}

export interface EditSnippet {
  tool: string;
  before: string;
  after: string;
}

interface ParsedChat {
  mtimeMs: number;
  size: number;
  items: ChatItem[];
  filesChanged: FileEdit[];
  toolPaths: string[];
}

interface ToolPart {
  name: string;
  input: unknown;
}

const HEAD_BYTES = 64 * 1024;
const MAX_TEXT = 20000;
const MAX_COMMAND = 300;
const MAX_NOTES = 6;
const MAX_SNIPPET = 20000;
const DEFAULT_PAGE = 40;
const LIST_REUSE_MS = 2000;
const PARSE_CACHE_SIZE = 20;
const ID_RE = /^[A-Za-z0-9-]{8,80}$/;

const EDIT_TOOLS = new Set(["StrReplace", "Write", "Delete", "ApplyPatch", "EditNotebook"]);
const READ_TOOLS = new Set(["Read", "ReadFile", "ReadLints"]);
const SEARCH_TOOLS = new Set(["Grep", "rg", "Glob", "SemanticSearch", "WebSearch", "WebFetch", "SearchConversations"]);
const INJECTED_TAGS = [
  "timestamp", "attached_files", "system_reminder", "image_files", "system-communication",
  "user_info", "git_status", "rules", "agent_skills", "agent_transcripts",
  "dynamic_tool_catalog", "open_and_recently_viewed_files", "manually_attached_skills",
];

export function projectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

/** User text arrives wrapped in <user_query>; everything else around it is injected context. */
export function cleanUserText(raw: string): string {
  const queries = [...raw.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim());
  if (queries.length) return queries.join("\n\n");
  let text = raw;
  for (const tag of INJECTED_TAGS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  return text.trim();
}

/** "Tuesday, Oct 6, 2026, 2:40 PM (UTC+5:30)" → ISO string. */
export function parseTimestampTag(raw: string): string | undefined {
  const m = raw.match(/<timestamp>[^,<]*,\s*([A-Za-z]{3,9}) (\d{1,2}), (\d{4}), (\d{1,2}:\d{2} [AP]M)(?: \(UTC([+-])(\d{1,2})(?::(\d{2}))?\))?/);
  if (!m) return undefined;
  const offset = m[5] ? `GMT${m[5]}${m[6].padStart(2, "0")}${m[7] || "00"}` : "";
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]} ${m[4]} ${offset}`.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Cursor names project folders after the absolute path with non-alphanumerics replaced by "-". */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "");
}

/** Longest ancestor of a tool path whose encoding equals the project folder name. */
export function repoFromToolPaths(project: string, toolPaths: string[]): string | null {
  for (const p of toolPaths) {
    if (!path.isAbsolute(p)) continue;
    let dir = p;
    while (dir && dir !== path.dirname(dir)) {
      if (encodeProjectPath(dir) === project) return dir;
      dir = path.dirname(dir);
    }
  }
  return null;
}

/** Fallback: rebuild the path by trying "/" or "-" at each dash and keeping what exists. */
export function decodeProjectName(project: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const parts = project.split("-").filter(Boolean);
  if (!parts.length || /^\d+$/.test(project)) return null;
  const walk = (dir: string, i: number): string | null => {
    if (i >= parts.length) return dir;
    let seg = parts[i];
    for (let j = i; j < parts.length; j++) {
      if (j > i) seg += "-" + parts[j];
      const next = path.join(dir, seg);
      if (exists(next)) {
        const found = walk(next, j + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(path.sep, 0);
}

/** Display name for a project whose folder may no longer exist: the part after the deepest existing ancestor. */
export function projectDisplayName(project: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (/^\d+$/.test(project)) return "No folder";
  const parts = project.split("-").filter(Boolean);
  let dir: string = path.sep;
  let i = 0;
  while (i < parts.length) {
    let seg = parts[i];
    let advanced = false;
    for (let j = i; j < parts.length - 1; j++) {
      if (j > i) seg += "-" + parts[j];
      if (exists(path.join(dir, seg))) {
        dir = path.join(dir, seg);
        i = j + 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  const rest = parts.slice(i).join("-");
  const leaf = rest.match(/(?:^|-)(?:repos|T)-([^]+)$/);
  return (leaf ? leaf[1] : rest) || path.basename(dir) || project;
}

function lineCount(s: unknown): number {
  return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

function patchFiles(patch: string): FileEdit[] {
  const out: FileEdit[] = [];
  let current: FileEdit | null = null;
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = {
        path: header[2].trim(),
        kind: header[1] === "Add" ? "added" : header[1] === "Delete" ? "deleted" : "modified",
        added: 0,
        removed: 0,
      };
      out.push(current);
      continue;
    }
    if (!current || line.startsWith("***")) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function editsFor(tool: ToolPart): FileEdit[] {
  const input = (tool.input || {}) as Record<string, unknown>;
  switch (tool.name) {
    case "StrReplace": {
      const p = str(input.path);
      return p ? [{ path: p, kind: "modified", added: lineCount(input.new_string), removed: lineCount(input.old_string) }] : [];
    }
    case "Write": {
      const p = str(input.path);
      return p ? [{ path: p, kind: "added", added: lineCount(input.contents), removed: 0 }] : [];
    }
    case "Delete": {
      const p = str(input.path);
      return p ? [{ path: p, kind: "deleted", added: 0, removed: 0 }] : [];
    }
    case "EditNotebook": {
      const p = str(input.target_notebook) || str(input.path);
      return p ? [{ path: p, kind: "modified", added: lineCount(input.new_string), removed: lineCount(input.old_string) }] : [];
    }
    case "ApplyPatch":
      return typeof tool.input === "string" ? patchFiles(tool.input) : [];
    default:
      return [];
  }
}

function toolPathsFor(tool: ToolPart): string[] {
  if (typeof tool.input === "string") return patchFiles(tool.input).map((e) => e.path);
  const input = (tool.input || {}) as Record<string, unknown>;
  return ["path", "working_directory", "target_directory", "target_notebook"]
    .map((k) => str(input[k]))
    .filter((v): v is string => !!v);
}

function mergeEdits(into: FileEdit[], edits: FileEdit[]) {
  for (const e of edits) {
    const prev = into.find((x) => x.path === e.path);
    if (!prev) {
      into.push({ ...e });
      continue;
    }
    prev.added += e.added;
    prev.removed += e.removed;
    if (e.kind === "deleted") prev.kind = "deleted";
    else if (prev.kind === "deleted") prev.kind = "modified";
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeWork(w: Omit<WorkSummary, "summary">): string {
  const parts: string[] = [];
  if (w.edits.length) parts.push(`Edited ${plural(w.edits.length, "file", "files")}`);
  if (w.commands.length) parts.push(`ran ${plural(w.commands.length, "command", "commands")}`);
  if (w.reads) parts.push(`read ${plural(w.reads, "file", "files")}`);
  if (w.searches) parts.push(`searched ${plural(w.searches, "time", "times")}`);
  if (!parts.length) return w.other ? `Used ${plural(w.other, "tool", "tools")}` : "Worked";
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Turn {
  user?: { text: string; line: number; timestamp?: string };
  texts: Array<{ text: string; line: number; order: number }>;
  tools: ToolPart[];
  firstToolLine: number;
  lastToolOrder: number;
}

function emptyTurn(): Turn {
  return { texts: [], tools: [], firstToolLine: -1, lastToolOrder: -1 };
}

/** Parse transcript lines into user messages, one work group per turn, and the final answer. */
export function parseTranscript(id: string, content: string): Omit<ParsedChat, "mtimeMs" | "size"> {
  const items: ChatItem[] = [];
  const filesChanged: FileEdit[] = [];
  const toolPaths: string[] = [];
  let turn = emptyTurn();
  let order = 0;

  const push = (role: ChatItem["role"], line: number, text: string, extra?: Partial<ChatItem>) => {
    items.push({ seq: items.length, id: `${id}:${line}:${role}`, role, text: text.slice(0, MAX_TEXT), ...extra });
  };

  const flush = () => {
    if (turn.user) push("user", turn.user.line, turn.user.text, { timestamp: turn.user.timestamp });
    const last = turn.texts[turn.texts.length - 1];
    const answer = last && last.order > turn.lastToolOrder ? last : undefined;
    if (turn.tools.length) {
      const edits: FileEdit[] = [];
      const commands: string[] = [];
      let reads = 0, searches = 0, other = 0;
      for (const t of turn.tools) {
        if (EDIT_TOOLS.has(t.name)) mergeEdits(edits, editsFor(t));
        else if (t.name === "Shell") {
          const c = str((t.input as Record<string, unknown> | undefined)?.command);
          if (c) commands.push(c.slice(0, MAX_COMMAND));
        } else if (READ_TOOLS.has(t.name)) reads++;
        else if (SEARCH_TOOLS.has(t.name)) searches++;
        else other++;
      }
      mergeEdits(filesChanged, edits);
      const notes = turn.texts.filter((t) => t !== answer).map((t) => t.text.slice(0, 400)).slice(-MAX_NOTES);
      const base = { edits, commands, reads, searches, other, notes };
      push("work", turn.firstToolLine, "", { work: { ...base, summary: describeWork(base) } });
      if (answer) push("assistant", answer.line, answer.text);
    } else {
      for (const t of turn.texts) push("assistant", t.line, t.text);
    }
    turn = emptyTurn();
  };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!obj?.role) {
      if (obj?.type === "turn_ended") flush();
      continue;
    }
    const parts = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (obj.role === "user") {
      const rawText = parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).join("\n");
      const text = cleanUserText(rawText);
      if (!text) continue;
      if (turn.user || turn.texts.length || turn.tools.length) flush();
      turn.user = { text, line: i, timestamp: parseTimestampTag(rawText) };
      continue;
    }
    if (obj.role !== "assistant") continue;
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
        turn.texts.push({ text: p.text.trim(), line: i, order: order++ });
      } else if (p?.type === "tool_use" && typeof p.name === "string") {
        const tool = { name: p.name, input: p.input };
        if (turn.firstToolLine < 0) turn.firstToolLine = i;
        turn.lastToolOrder = order++;
        turn.tools.push(tool);
        toolPaths.push(...toolPathsFor(tool));
      }
    }
  }
  flush();
  return { items, filesChanged, toolPaths };
}

/** Before/after snippets for one file, used as a diff when the repository has no git. */
export function editSnippets(content: string, filePath: string): EditSnippet[] {
  const out: EditSnippet[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.includes(filePath)) continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const parts = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    for (const p of parts) {
      if (p?.type !== "tool_use") continue;
      const input = p.input;
      if (p.name === "StrReplace" && input?.path === filePath) {
        out.push({ tool: p.name, before: String(input.old_string || "").slice(0, MAX_SNIPPET), after: String(input.new_string || "").slice(0, MAX_SNIPPET) });
      } else if (p.name === "Write" && input?.path === filePath) {
        out.push({ tool: p.name, before: "", after: String(input.contents || "").slice(0, MAX_SNIPPET) });
      } else if (p.name === "ApplyPatch" && typeof input === "string") {
        const section = input.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m)
          .find((s: string) => s.startsWith("*** ") && s.split("\n")[0].endsWith(filePath));
        if (section) {
          const body = section.split("\n").slice(1).filter((l: string) => !l.startsWith("*** End"));
          out.push({
            tool: p.name,
            before: body.filter((l: string) => l.startsWith("-") || l.startsWith(" ")).map((l: string) => l.slice(1)).join("\n").slice(0, MAX_SNIPPET),
            after: body.filter((l: string) => l.startsWith("+") || l.startsWith(" ")).map((l: string) => l.slice(1)).join("\n").slice(0, MAX_SNIPPET),
          });
        }
      }
    }
  }
  return out;
}

function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function titleFromHead(head: string): string {
  for (const line of head.split("\n")) {
    if (!line.includes('"user"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.role !== "user") continue;
      const raw = (obj.message?.content || []).filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).join("\n");
      const text = cleanUserText(raw).replace(/\s+/g, " ").trim();
      if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    } catch {
      // A truncated last line in the head buffer is expected.
    }
  }
  return "New Chat";
}

export class TranscriptIndex {
  private summaries = new Map<string, { mtimeMs: number; summary: ChatSummary; file: string }>();
  private parsed = new Map<string, ParsedChat>();
  private repoCache = new Map<string, string | null>();
  private nameCache = new Map<string, string>();
  private scannedAt = 0;

  constructor(private readonly root: string = projectsRoot()) {}

  /** Locate a chat's transcript file. IDs are validated so they can never escape the root. */
  findFile(chatId: string): string | null {
    if (!ID_RE.test(chatId)) return null;
    const cached = this.summaries.get(chatId);
    if (cached && fs.existsSync(cached.file)) return cached.file;
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(this.root);
    } catch {
      return null;
    }
    for (const project of projects) {
      const file = path.join(this.root, project, "agent-transcripts", chatId, `${chatId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  /** All chats, newest first. Only the first 64 KB of each file is read, and only when it changed. */
  list(options: { limit?: number; offset?: number; query?: string } = {}): { chats: ChatSummary[]; total: number } {
    // Searching re-lists on every keystroke; a scan stats every transcript, so reuse a recent one.
    if (Date.now() - this.scannedAt >= LIST_REUSE_MS) this.scan();
    const q = options.query?.trim().toLowerCase();
    const all = [...this.summaries.values()]
      .map((s) => s.summary)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = Math.max(0, options.offset || 0);
    const limit = Math.min(500, Math.max(1, options.limit || 200));
    return { chats: all.slice(offset, offset + limit), total: all.length };
  }

  private scan(): void {
    this.scannedAt = Date.now();
    const seen = new Set<string>();
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(this.root);
    } catch {
      this.summaries.clear();
      return;
    }
    for (const project of projects) {
      const dir = path.join(this.root, project, "agent-transcripts");
      let ids: string[] = [];
      try {
        ids = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const id of ids) {
        if (!ID_RE.test(id)) continue;
        const file = path.join(dir, id, `${id}.jsonl`);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        seen.add(id);
        const prev = this.summaries.get(id);
        if (prev && prev.mtimeMs === st.mtimeMs && prev.file === file) continue;
        let title = prev?.summary.title || "New Chat";
        try {
          title = titleFromHead(readHead(file));
        } catch {
          // Keep the previous title when the file is mid-write.
        }
        const repoPath = this.repoFor(project, file);
        this.summaries.set(id, {
          mtimeMs: st.mtimeMs,
          file,
          summary: {
            id,
            title,
            project,
            repoPath,
            repoName: repoPath ? path.basename(repoPath) : this.displayName(project),
            createdAt: new Date(st.birthtimeMs || st.ctimeMs).toISOString(),
            updatedAt: st.mtime.toISOString(),
          },
        });
      }
    }
    for (const id of [...this.summaries.keys()]) if (!seen.has(id)) this.summaries.delete(id);
  }

  summary(chatId: string): ChatSummary | null {
    if (!this.summaries.has(chatId) && this.findFile(chatId)) this.scan();
    return this.summaries.get(chatId)?.summary || null;
  }

  /** Latest `limit` items, or the page ending just before `before` (a seq number). */
  get(chatId: string, options: { before?: number; limit?: number } = {}): ChatPage | null {
    const file = this.findFile(chatId);
    if (!file) return null;
    const parsed = this.parse(chatId, file);
    const chat = this.summary(chatId);
    if (!parsed || !chat) return null;
    const limit = Math.min(200, Math.max(1, options.limit || DEFAULT_PAGE));
    const end = options.before != null ? Math.max(0, Math.min(parsed.items.length, options.before)) : parsed.items.length;
    const start = Math.max(0, end - limit);
    return {
      chat,
      items: parsed.items.slice(start, end),
      total: parsed.items.length,
      hasOlder: start > 0,
      filesChanged: parsed.filesChanged,
    };
  }

  /** Items with seq >= `fromSeq`. The last known item is included again because it may still be growing. */
  since(chatId: string, fromSeq: number): { items: ChatItem[]; total: number; mtimeMs: number } | null {
    const file = this.findFile(chatId);
    if (!file) return null;
    const parsed = this.parse(chatId, file);
    if (!parsed) return null;
    return { items: parsed.items.slice(Math.max(0, fromSeq)), total: parsed.items.length, mtimeMs: parsed.mtimeMs };
  }

  filesChanged(chatId: string): FileEdit[] {
    const file = this.findFile(chatId);
    return (file && this.parse(chatId, file)?.filesChanged) || [];
  }

  snippets(chatId: string, filePath: string): EditSnippet[] {
    const file = this.findFile(chatId);
    if (!file) return [];
    try {
      return editSnippets(fs.readFileSync(file, "utf8"), filePath);
    } catch {
      return [];
    }
  }

  repoPath(chatId: string): string | null {
    return this.summary(chatId)?.repoPath ?? null;
  }

  private parse(chatId: string, file: string): ParsedChat | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const prev = this.parsed.get(chatId);
    // Re-inserting keeps the map in least-recently-used order, so watched chats are never evicted.
    this.parsed.delete(chatId);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      this.parsed.set(chatId, prev);
      return prev;
    }
    const result = { ...parseTranscript(chatId, fs.readFileSync(file, "utf8")), mtimeMs: st.mtimeMs, size: st.size };
    this.parsed.set(chatId, result);
    if (this.parsed.size > PARSE_CACHE_SIZE) this.parsed.delete(this.parsed.keys().next().value!);
    return result;
  }

  private displayName(project: string): string {
    if (!this.nameCache.has(project)) this.nameCache.set(project, projectDisplayName(project));
    return this.nameCache.get(project)!;
  }

  private repoFor(project: string, file: string): string | null {
    if (this.repoCache.has(project)) return this.repoCache.get(project)!;
    let repo: string | null = null;
    try {
      const head = readHead(file);
      const paths = [...head.matchAll(/"(?:path|working_directory|target_directory)":"([^"]+)"/g)].map((m) => m[1]);
      repo = repoFromToolPaths(project, paths);
    } catch {
      // Fall through to decoding the folder name.
    }
    if (!repo) repo = decodeProjectName(project);
    this.repoCache.set(project, repo);
    return repo;
  }
}
