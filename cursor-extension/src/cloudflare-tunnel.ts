/**
 * Cloudflare Tunnel manager — quick tunnels for Cursor Remote local WS.
 * Spawns cloudflared, parses public URL, auto-restarts on crash, copies wss URL.
 */

import * as vscode from "vscode";
import { spawn, ChildProcess, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const URL_RE =
  /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi;

/** Hosts that appear in error logs but are NOT real quick-tunnel URLs */
const RESERVED_TRYCLOUDFLARE_HOSTS = new Set([
  "api",
  "www",
  "dash",
  "developers",
  "cloudflare",
  "update",
]);

const STATE_KEY_URL = "cursorRemote.cloudflareTunnel.wssUrl";
const STATE_KEY_HTTPS = "cursorRemote.cloudflareTunnel.httpsUrl";

export class CloudflareTunnelManager {
  private process: ChildProcess | null = null;
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private httpsUrl: string | null = null;
  private wssUrl: string | null = null;
  private localPort: number = 8766;
  private intentionalStop = false;
  private suppressRestart = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private urlWaiters: Array<{
    resolve: (url: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private pendingHttpsUrl: string | null = null;
  private edgeReady = false;
  private logBuffer = "";
  private onUrlChanged: ((wssUrl: string | null) => void) | null = null;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.wssUrl = context.globalState.get<string>(STATE_KEY_URL) ?? null;
    this.httpsUrl = context.globalState.get<string>(STATE_KEY_HTTPS) ?? null;
    // Drop previously saved false-positive URLs (e.g. wss://api.trycloudflare.com)
    if (
      this.httpsUrl &&
      !this.isValidQuickTunnelHttps(this.httpsUrl)
    ) {
      this.wssUrl = null;
      this.httpsUrl = null;
      void context.globalState.update(STATE_KEY_URL, undefined);
      void context.globalState.update(STATE_KEY_HTTPS, undefined);
    }
  }

  setOnUrlChanged(cb: ((wssUrl: string | null) => void) | null) {
    this.onUrlChanged = cb;
  }

  isRunning(): boolean {
    return this.process != null && this.process.exitCode == null;
  }

  getWssUrl(): string | null {
    return this.wssUrl;
  }

  getHttpsUrl(): string | null {
    return this.httpsUrl;
  }

  private log(msg: string) {
    this.outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] [CloudflareTunnel] ${msg}`
    );
  }

  /** Resolve cloudflared binary: setting → PATH → common install locations */
  resolveBinary(): string {
    const cfg = vscode.workspace.getConfiguration("cursorRemote");
    const configured = (cfg.get<string>("cloudflaredPath") || "").trim();
    if (configured) {
      if (fs.existsSync(configured)) return configured;
      throw new Error(
        `Configured cloudflaredPath not found: ${configured}`
      );
    }

    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const found = execFileSync(whichCmd, ["cloudflared"], {
        encoding: "utf8",
        timeout: 3000,
      })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      if (found && fs.existsSync(found)) return found;
    } catch {
      // fall through
    }

    const candidates =
      process.platform === "darwin"
        ? [
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
            path.join(os.homedir(), "bin/cloudflared"),
          ]
        : process.platform === "win32"
          ? [
              path.join(
                process.env.LOCALAPPDATA || "",
                "cloudflared",
                "cloudflared.exe"
              ),
              "C:\\Program Files\\cloudflared\\cloudflared.exe",
            ]
          : ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];

    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }

    throw new Error(
      "cloudflared not found. Install: brew install cloudflared  (or set cursorRemote.cloudflaredPath)"
    );
  }

  async start(localPort: number): Promise<string> {
    if (this.isRunning() && this.wssUrl) {
      this.log(`Already running → ${this.wssUrl}`);
      return this.wssUrl;
    }

    if (this.isRunning()) {
      await this.stop();
    }

    this.localPort = localPort;
    this.intentionalStop = false;
    this.suppressRestart = false;
    this.restartAttempts = 0;
    return this.spawnAndWaitForUrl();
  }

  private spawnAndWaitForUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      let binary: string;
      try {
        binary = this.resolveBinary();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const cfg = vscode.workspace.getConfiguration("cursorRemote");
      const protocol = (cfg.get<string>("cloudflareTunnelProtocol") || "http2").trim() || "http2";
      const target = `http://127.0.0.1:${this.localPort}`;
      const args = [
        "tunnel",
        "--url",
        target,
        "--no-autoupdate",
        "--protocol",
        protocol,
      ];
      this.log(`Starting: ${binary} ${args.join(" ")}`);
      this.logBuffer = "";
      this.pendingHttpsUrl = null;
      this.edgeReady = false;

      const child = spawn(binary, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.process = child;

      // URL can appear quickly; edge registration may take longer (or never under Zscaler).
      const timeoutMs = 120000;
      const timer = setTimeout(() => {
        this.clearWaiter(resolve);
        const hint = this.pendingHttpsUrl
          ? `Got URL ${this.pendingHttpsUrl} but Cloudflare edge never connected (port 7844 often blocked). Use Local Wi‑Fi instead.`
          : "Timed out waiting for Cloudflare Tunnel. Check output channel / network (Zscaler may block tunnels).";
        reject(new Error(hint));
        void this.stop();
      }, timeoutMs);

      this.urlWaiters.push({ resolve, reject, timer });

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.logBuffer += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.log(line.trim());
        }
        this.tryParseTunnelProgress();
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err) => {
        this.log(`Process error: ${err.message}`);
        this.rejectWaiters(err);
        this.process = null;
      });

      child.on("close", (code, signal) => {
        this.log(`Exited code=${code} signal=${signal}`);
        this.process = null;
        if (!this.intentionalStop) {
          if (this.urlWaiters.length > 0) {
            this.rejectWaiters(
              new Error(
                `cloudflared exited before URL was ready (code ${code})`
              )
            );
          }
          if (!this.suppressRestart) {
            this.scheduleRestart();
          } else {
            this.setUrls(null, null);
          }
        } else {
          this.setUrls(null, null);
        }
      });
    });
  }

  private isValidQuickTunnelHttps(https: string): boolean {
    try {
      const u = new URL(https);
      if (u.protocol !== "https:") return false;
      if (!u.hostname.toLowerCase().endsWith(".trycloudflare.com")) return false;
      const sub = u.hostname
        .slice(0, -".trycloudflare.com".length)
        .toLowerCase();
      if (!sub || sub.includes(".")) return false;
      if (RESERVED_TRYCLOUDFLARE_HOSTS.has(sub)) return false;
      // Quick tunnels look like: word-word-word.trycloudflare.com
      return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(sub);
    } catch {
      return false;
    }
  }

  private tryParseTunnelProgress() {
    // Surface hard failures immediately (don't keep waiting for a fake URL)
    const failMatch = this.logBuffer.match(
      /failed to request quick Tunnel:\s*(.+)/i
    );
    if (failMatch && this.urlWaiters.length > 0) {
      const detail = failMatch[1].trim().slice(0, 220);
      const looksBlocked =
        /timeout|deadline|certificate|tls|forbidden|403|blocked|zscaler/i.test(
          detail
        );
      if (looksBlocked) {
        this.suppressRestart = true;
        this.log(
          "Network/proxy looks blocked — skipping auto-restart. Use Local Wi‑Fi or hotspot."
        );
      }
      this.rejectWaiters(
        new Error(
          looksBlocked
            ? `Cloudflare Tunnel API unreachable from this network (${detail}). ` +
              `Corporate proxy/Zscaler often blocks api.trycloudflare.com. ` +
              `Use Local (same Wi‑Fi) or retry on mobile hotspot.`
            : `Cloudflare quick tunnel failed: ${detail}`
        )
      );
      return;
    }

    // Edge connectivity pre-checks failed (common: TCP/UDP 7844 blocked)
    if (
      /hard_fail=true|HTTP\/2 connection is blocked|Unable to establish connection with Cloudflare edge|dial tcp .*:7844: i\/o timeout/i.test(
        this.logBuffer
      )
    ) {
      if (this.urlWaiters.length > 0) {
        this.suppressRestart = true;
        this.rejectWaiters(
          new Error(
            "Cloudflare edge is blocked on this network (outbound TCP/UDP 7844). " +
              "A tunnel URL may appear but the phone cannot connect. " +
              "Use Local (same Wi‑Fi) — check the log for the real port (e.g. 8767)."
          )
        );
      }
      return;
    }

    URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let best: string | null = null;
    while ((match = URL_RE.exec(this.logBuffer)) != null) {
      const https = `https://${match[1]}.trycloudflare.com`;
      if (this.isValidQuickTunnelHttps(https)) {
        best = https;
      }
    }
    if (best && best !== this.pendingHttpsUrl) {
      this.pendingHttpsUrl = best;
      this.log(
        `Tunnel URL allocated: ${best} — waiting for Cloudflare edge connection…`
      );
    }

    // Only treat as ready once the edge connection is registered
    const edgeOk =
      /Registered tunnel connection|Registered connection|connIndex=\d+.*registered/i.test(
        this.logBuffer
      );
    if (edgeOk && this.pendingHttpsUrl && !this.edgeReady) {
      this.edgeReady = true;
      const wss = this.pendingHttpsUrl.replace(/^https:/i, "wss:");
      this.setUrls(this.pendingHttpsUrl, wss);
      this.log(`Public URL ready (edge connected): ${wss}`);
      this.restartAttempts = 0;
      this.resolveWaiters(wss);
    }
  }

  private setUrls(https: string | null, wss: string | null) {
    this.httpsUrl = https;
    this.wssUrl = wss;
    void this.context.globalState.update(STATE_KEY_URL, wss);
    void this.context.globalState.update(STATE_KEY_HTTPS, https);
    this.onUrlChanged?.(wss);
  }

  private resolveWaiters(url: string) {
    const waiters = [...this.urlWaiters];
    this.urlWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(url);
    }
  }

  private rejectWaiters(err: Error) {
    const waiters = [...this.urlWaiters];
    this.urlWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private clearWaiter(resolve: (url: string) => void) {
    this.urlWaiters = this.urlWaiters.filter((w) => {
      if (w.resolve === resolve) {
        clearTimeout(w.timer);
        return false;
      }
      return true;
    });
  }

  private scheduleRestart() {
    if (this.intentionalStop || this.suppressRestart) return;
    const cfg = vscode.workspace.getConfiguration("cursorRemote");
    const autoRestart = cfg.get<boolean>("cloudflareTunnelAutoRestart", true);
    if (!autoRestart) return;

    const max = cfg.get<number>("cloudflareTunnelMaxRestarts", 5) ?? 5;
    if (this.restartAttempts >= max) {
      this.log(`Gave up auto-restart after ${max} attempts`);
      vscode.window.showErrorMessage(
        "Cursor Remote: Cloudflare Tunnel crashed repeatedly. Run “Start Cloudflare Tunnel” again."
      );
      this.setUrls(null, null);
      return;
    }

    this.restartAttempts += 1;
    const delay = Math.min(15000, 1000 * 2 ** (this.restartAttempts - 1));
    this.log(
      `Auto-restart in ${delay}ms (attempt ${this.restartAttempts}/${max})`
    );
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.intentionalStop || this.isRunning()) return;
      void this.spawnAndWaitForUrl()
        .then(async (url) => {
          // Quick tunnels get a new URL on restart, so the phone needs the new one.
          const pick = await vscode.window.showInformationMessage(
            `Cursor Remote: tunnel restarted with a new URL: ${url}`,
            "Copy URL"
          );
          if (pick) await vscode.env.clipboard.writeText(url);
        })
        .catch((e) => {
          this.log(
            `Restart failed: ${e instanceof Error ? e.message : String(e)}`
          );
        });
    }, delay);
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectWaiters(new Error("Tunnel stopped"));
    const proc = this.process;
    this.process = null;
    if (proc && proc.exitCode == null) {
      this.log("Stopping cloudflared…");
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => setTimeout(r, 400));
      if (proc.exitCode == null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    this.setUrls(null, null);
    this.log("Stopped");
  }

  async copyWssUrl(): Promise<string | null> {
    if (!this.wssUrl) return null;
    await vscode.env.clipboard.writeText(this.wssUrl);
    return this.wssUrl;
  }
}
