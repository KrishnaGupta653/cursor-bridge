/**
 * Status bar management for Cursor Remote extension
 */

import * as vscode from "vscode";
import { WebSocketServer } from "./websocket-server";

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private wsServer: WebSocketServer | null = null;
  private relayClient: {
    isConnectedToSession: () => boolean;
    getSessionId: () => string | null;
  } | null = null;
  private telegramRunning: () => boolean = () => false;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "cursorRemote.status",
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = "Cursor Remote";
    this.statusBarItem.command = "cursorRemote.statusBarClick";
    context.subscriptions.push(this.statusBarItem);
  }

  setWebSocketServer(wsServer: WebSocketServer) {
    this.wsServer = wsServer;
  }

  setRelayClient(
    relayClient: {
      isConnectedToSession: () => boolean;
      getSessionId: () => string | null;
    } | null
  ) {
    this.relayClient = relayClient;
  }

  setTelegramStatus(isRunning: () => boolean) {
    this.telegramRunning = isRunning;
  }

  /** Refresh from current state. Idle is the normal state, so it is never shown as a warning. */
  refresh() {
    const running = this.wsServer?.isRunning() ?? false;
    const port = this.wsServer?.getActualPort() ?? null;
    const devices = this.wsServer?.getClientCount() ?? 0;
    const relaySession = this.relayClient?.isConnectedToSession() ? this.relayClient.getSessionId() : null;
    const telegram = this.telegramRunning();

    let text: string;
    let summary: string;
    let background: vscode.ThemeColor | undefined;
    if (!running) {
      text = "$(circle-slash) Remote off";
      summary = "Server stopped";
      background = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (devices > 0 || relaySession) {
      const parts = [
        devices > 0 ? `${devices} device${devices === 1 ? "" : "s"}` : "",
        relaySession ? `relay ${relaySession}` : "",
      ].filter(Boolean);
      text = `$(broadcast) Remote · ${parts.join(" · ")}`;
      summary = `Connected: ${parts.join(", ")}`;
    } else {
      text = `$(broadcast) Remote :${port}${telegram ? " $(circle-small-filled)" : ""}`;
      summary = `Ready on port ${port}, no device connected`;
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Cursor Remote** — ${summary}\n\n`);
    tooltip.appendMarkdown(`- Local server: ${running ? `port \`${port}\`` : "stopped"}\n`);
    tooltip.appendMarkdown(`- Paired devices connected: ${devices}\n`);
    tooltip.appendMarkdown(`- Telegram bot: ${telegram ? "running in this window" : "not in this window"}\n`);
    tooltip.appendMarkdown(`- Relay: ${relaySession ? `session \`${relaySession}\`` : "off"}\n\n`);
    tooltip.appendMarkdown("Click for actions (pair a device, Telegram, tunnel, log)");

    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.backgroundColor = background;
    this.statusBarItem.accessibilityInformation = {
      label: `Cursor Remote: ${summary}${telegram ? ", Telegram bot running" : ""}. Activate for actions.`,
      role: "button",
    };
    this.statusBarItem.show();
  }

  /** Called when WebSocket clients connect/disconnect. */
  update(_connected: boolean) {
    this.refresh();
  }

  show() {
    this.statusBarItem.show();
  }
}
