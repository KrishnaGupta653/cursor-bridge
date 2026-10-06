/**
 * WorkspaceDiff — read-only git diffs for a chat's repository.
 * git runs through execFile (never a shell). Every diff passes --no-ext-diff and
 * --no-textconv, and fsmonitor is off, so repository config cannot start other programs.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EditSnippet } from "./transcript-index";

export interface DiffStat {
  path: string;
  added: number;
  removed: number;
  kind: "added" | "modified" | "deleted";
  binary?: boolean;
}

export interface FileDiff {
  path: string;
  diff: string;
  truncated: boolean;
  source: "git" | "transcript";
}

const MAX_DIFF_BYTES = 256 * 1024;
const MAX_FILES = 300;
const GIT_TIMEOUT_MS = 5000;
const SAFE_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=off",
  "-c", "color.ui=false",
];

export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_DIFF_BYTES * 4,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
        windowsHide: true,
      },
      (error, stdout) => {
        const exit = (error as { code?: unknown } | null)?.code;
        const code = !error ? 0 : typeof exit === "number" ? exit : -1;
        // `git diff --no-index` exits 1 when files differ; that is a result, not a failure.
        if (error && code !== 1) reject(error);
        else resolve({ stdout: String(stdout), code });
      }
    );
  });

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Resolve `file` (absolute or repo-relative) to a repo-relative path, or null if it escapes the repository. */
export function containedRelative(repoRoot: string, file: string): string | null {
  if (!file || file.includes("\0")) return null;
  const root = realpathOrNull(repoRoot) || path.resolve(repoRoot);
  const abs = path.resolve(root, path.isAbsolute(file) ? path.relative(repoRoot, file) : file);
  const parent = realpathOrNull(path.dirname(abs));
  const resolved = parent ? path.join(parent, path.basename(abs)) : abs;
  const real = realpathOrNull(resolved) || resolved;
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function cap(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_DIFF_BYTES) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated: true };
}

/** A unified-style diff built from transcript edit snippets when git is unavailable. */
export function diffFromSnippets(file: string, snippets: EditSnippet[]): FileDiff {
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const s of snippets) {
    const before = s.before ? s.before.split("\n") : [];
    const after = s.after ? s.after.split("\n") : [];
    out.push(`@@ -1,${before.length} +1,${after.length} @@ ${s.tool}`);
    for (const l of before) out.push(`-${l}`);
    for (const l of after) out.push(`+${l}`);
  }
  const { text, truncated } = cap(out.join("\n"));
  return { path: file, diff: text, truncated, source: "transcript" };
}

export class WorkspaceDiff {
  private roots = new Map<string, string | null>();

  constructor(private readonly git: GitRunner = runGit) {}

  /** Top-level of the git repository containing `repoPath`, or null when it is not a git checkout. */
  async gitRoot(repoPath: string | null | undefined): Promise<string | null> {
    if (!repoPath || !path.isAbsolute(repoPath) || !fs.existsSync(repoPath)) return null;
    if (this.roots.has(repoPath)) return this.roots.get(repoPath)!;
    let root: string | null = null;
    try {
      const { stdout } = await this.git(repoPath, ["rev-parse", "--show-toplevel"]);
      root = stdout.trim() || null;
    } catch {
      root = null;
    }
    this.roots.set(repoPath, root);
    return root;
  }

  /** Uncommitted changes against HEAD, including untracked files. */
  async stats(repoPath: string | null | undefined): Promise<DiffStat[] | null> {
    const root = await this.gitRoot(repoPath);
    if (!root) return null;
    const out: DiffStat[] = [];
    const tracked = await this.git(root, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"])
      .catch(() => this.git(root, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "--"]));
    const status = await this.git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]).catch(() => ({ stdout: "", code: 0 }));
    const deleted = new Set<string>();
    const untracked: string[] = [];
    for (const entry of status.stdout.split("\0")) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code === "??") untracked.push(file);
      else if (code.includes("D")) deleted.add(file);
    }
    for (const line of tracked.stdout.split("\n")) {
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!m) continue;
      const binary = m[1] === "-";
      out.push({
        path: m[3],
        added: binary ? 0 : Number(m[1]),
        removed: binary ? 0 : Number(m[2]),
        kind: deleted.has(m[3]) ? "deleted" : "modified",
        ...(binary ? { binary } : {}),
      });
      if (out.length >= MAX_FILES) return out;
    }
    for (const file of untracked) {
      let added = 0;
      try {
        const st = fs.statSync(path.join(root, file));
        if (st.size <= MAX_DIFF_BYTES) added = fs.readFileSync(path.join(root, file), "utf8").split("\n").length;
      } catch {
        // Counted as 0 lines when unreadable.
      }
      out.push({ path: file, added, removed: 0, kind: "added" });
      if (out.length >= MAX_FILES) break;
    }
    return out;
  }

  /** Unified diff for one file inside the repository. Returns null when git is unavailable. */
  async fileDiff(repoPath: string | null | undefined, file: string): Promise<FileDiff | { error: string } | null> {
    const root = await this.gitRoot(repoPath);
    if (!root) return null;
    const rel = containedRelative(root, file);
    if (!rel) return { error: "File is outside the chat's repository" };
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", rel];
    let { stdout } = await this.git(root, args).catch(() => this.git(root, args.filter((a) => a !== "HEAD")));
    if (!stdout.trim()) {
      const tracked = await this.git(root, ["ls-files", "--error-unmatch", "--", rel]).then((r) => r.code === 0, () => false);
      if (!tracked && fs.existsSync(path.join(root, rel))) {
        ({ stdout } = await this.git(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", rel]));
      }
    }
    const { text, truncated } = cap(stdout);
    return { path: rel, diff: text, truncated, source: "git" };
  }
}
