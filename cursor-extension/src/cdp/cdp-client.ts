/**
 * Low-level CDP HTTP + WebSocket client (localhost only).
 * Uses Node http + existing `ws` dependency — no raw CDP proxy to clients.
 */

import * as http from "http";
import WebSocket from "ws";
import { CdpTargetInfo } from "./cdp-types";

/** Only page sockets on the configured loopback port; whatever answers /json/list is not trusted to point elsewhere. */
export function isAllowedDebuggerUrl(url: string | undefined, port: number): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "ws:" && u.hostname === "127.0.0.1" && Number(u.port) === port &&
      !u.username && !u.password && !u.search && !u.hash && /^\/devtools\/page\/[A-Za-z0-9-]{1,80}$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Cursor's DevTools endpoint reports an Electron (or Cursor) user agent; anything else on the port is refused. */
export function looksLikeCursor(version: Record<string, unknown> | null | undefined): boolean {
  const ua = String(version?.["User-Agent"] ?? "");
  return /\bElectron\/\d/.test(ua) || /\bCursor\/\d/.test(ua);
}

export interface CdpClientOptions {
  host: string;
  port: number;
  log: (msg: string) => void;
  logError: (msg: string, err?: unknown) => void;
}

export class CdpHttpClient {
  constructor(private readonly options: CdpClientOptions) {}

  get baseUrl(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return new Promise<T>((resolve, reject) => {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if ((res.statusCode || 0) >= 400) {
            reject(
              new Error(
                `CDP HTTP ${res.statusCode} for ${path}: ${body.slice(0, 200)}`
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(
              new Error(
                `Invalid JSON from CDP ${path}: ${
                  e instanceof Error ? e.message : String(e)
                }`
              )
            );
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`CDP HTTP timeout for ${path}`));
      });
      req.on("error", reject);
    });
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    // Prefer /json/list; fall back to /json
    let raw: any[];
    try {
      raw = await this.getJson<any[]>("/json/list");
    } catch {
      raw = await this.getJson<any[]>("/json");
    }
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((t) => ({
      id: String(t.id || t.targetId || ""),
      title: String(t.title || ""),
      url: String(t.url || ""),
      type: String(t.type || "unknown"),
      webSocketDebuggerUrl: isAllowedDebuggerUrl(t.webSocketDebuggerUrl, this.options.port)
        ? String(t.webSocketDebuggerUrl)
        : undefined,
      description: t.description ? String(t.description) : undefined,
      attached: false,
    }));
  }

  async getVersion(): Promise<Record<string, string>> {
    const version = await this.getJson<Record<string, string>>("/json/version");
    if (!looksLikeCursor(version)) {
      throw new Error(`Port ${this.options.port} is not Cursor's DevTools endpoint; refusing to attach`);
    }
    return version;
  }
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * One CDP WebSocket session attached to a single target.
 */
export class CdpSessionSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();

  constructor(
    private readonly debuggerUrl: string,
    private readonly log: (msg: string) => void,
    private readonly logError: (msg: string, err?: unknown) => void,
    private readonly onClosed?: () => void
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.debuggerUrl, {
        // Localhost only — never configure remote CDP URLs here.
        handshakeTimeout: 8000,
      });
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onOpen = () => {
        cleanup();
        this.ws = ws;
        ws.on("message", (data) => this.onMessage(data.toString()));
        ws.on("close", () => this.onClose());
        ws.on("error", (e) =>
          this.logError("[CDP] Session socket error", e)
        );
        resolve();
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.on("open", onOpen);
      ws.on("error", onError);
    });
  }

  private onClose() {
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    this.onClosed?.();
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new Error(
            msg.error.message || JSON.stringify(msg.error).slice(0, 300)
          )
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch (e) {
            this.logError(`[CDP] Event handler error for ${msg.method}`, e);
          }
        }
      }
    }
  }

  on(method: string, handler: (params: any) => void): () => void {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method)!.add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP session not connected");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(payload);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed";
      throw new Error(text);
    }
    return result?.result?.value as T;
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP session disposed"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
