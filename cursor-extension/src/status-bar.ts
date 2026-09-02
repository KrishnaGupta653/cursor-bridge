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

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "cursorRemote.statusBarClick";
    this.statusBarItem.tooltip =
      "Cursor Remote: Click to connect to relay (Session ID · PIN) or show connection info";
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Set WebSocket server reference
   */
  setWebSocketServer(wsServer: WebSocketServer) {
    this.wsServer = wsServer;
  }

  /**
   * Set relay client reference (for status when connected via relay)
   */
  setRelayClient(
    relayClient: {
      isConnectedToSession: () => boolean;
      getSessionId: () => string | null;
    } | null
  ) {
    this.relayClient = relayClient;
  }

  /**
   * Refresh status bar from current state (local WebSocket + relay)
   */
  refresh() {
    if (!this.statusBarItem) return;

    const hasLocalClient = this.wsServer
      ? this.wsServer.getClientCount() > 0
      : false;
    const hasRelaySession = this.relayClient
      ? this.relayClient.isConnectedToSession()
      : false;
    const connected = hasLocalClient || hasRelaySession;

    if (this.wsServer && this.wsServer.isRunning()) {
      if (connected) {
        if (hasRelaySession && this.relayClient) {
          const sessionId = this.relayClient.getSessionId();
          this.statusBarItem.text =
            sessionId != null
              ? `$(cloud) Cursor Remote: Connected (Session: ${sessionId})`
              : "$(cloud) Cursor Remote: Connected";
          this.statusBarItem.tooltip =
            (sessionId != null
              ? `Cursor Remote: Relay session ${sessionId}`
              : "Cursor Remote: Connected to relay session") +
            " · Click: show connection info";
        } else {
          this.statusBarItem.text = "$(cloud) Cursor Remote: Connected";
          this.statusBarItem.tooltip =
            "Cursor Remote: Client connected · Click: show connection info";
        }
        this.statusBarItem.backgroundColor = undefined;
      } else if (!hasRelaySession) {
        this.statusBarItem.text = "$(cloud) Cursor Remote: Inactive";
        this.statusBarItem.tooltip =
          "Cursor Remote: Relay off · Click: enter Session ID and PIN to connect";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
      } else {
        this.statusBarItem.text =
          "$(cloud) Cursor Remote: Ready (waiting for client)";
        this.statusBarItem.tooltip =
          "Cursor Remote: Waiting for client · Click: show connection info";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
      }
    } else {
      this.statusBarItem.text = "$(cloud-off) Cursor Remote: Stopped";
      this.statusBarItem.tooltip =
        "Cursor Remote: Server stopped · Click: show connection info";
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    }
    this.statusBarItem.show();
  }

  /**
   * Update status bar (called when WebSocket client connects/disconnects)
   */
  update(connected: boolean) {
    this.refresh();
  }

  /**
   * Show status bar
   */
  show() {
    this.statusBarItem.show();
  }
}
