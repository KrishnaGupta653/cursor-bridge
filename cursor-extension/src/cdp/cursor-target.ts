/**
 * Score and rank CDP targets that may contain Cursor Agent / chat UI.
 */

import { CdpTargetInfo } from "./cdp-types";

const TITLE_HINTS = [
  /cursor/i,
  /agent/i,
  /chat/i,
  /composer/i,
  /ask/i,
  /plan/i,
];

const URL_HINTS = [
  /workbench/i,
  /vscode-file/i,
  /vscode-webview/i,
  /cursor/i,
  /devtools/i,
];

/**
 * Prefer page/webview targets that look like Cursor workbench / agent UI.
 * Does not invent Agent presence — high score only means "worth attaching".
 */
export function scoreCursorTarget(target: CdpTargetInfo): number {
  let score = 0;
  const type = (target.type || "").toLowerCase();

  if (type === "page") score += 30;
  else if (type === "webview" || type === "iframe") score += 20;
  else if (type === "service_worker" || type === "worker") score -= 50;
  else score += 5;

  for (const re of TITLE_HINTS) {
    if (re.test(target.title || "")) score += 12;
  }
  for (const re of URL_HINTS) {
    if (re.test(target.url || "")) score += 10;
  }

  // Blank / new-tab style pages are poor candidates
  if (!target.title || target.title === "about:blank") score -= 20;
  if ((target.url || "").startsWith("devtools://")) score -= 80;
  if (/devtools/i.test(target.title || "")) score -= 30;

  // Must have a debugger URL to attach
  if (!target.webSocketDebuggerUrl) score -= 100;

  return score;
}

export function rankTargets(targets: CdpTargetInfo[]): CdpTargetInfo[] {
  return targets
    .map((t) => ({ ...t, score: scoreCursorTarget(t) }))
    .filter((t) => (t.score || 0) > 0 && !!t.webSocketDebuggerUrl)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}
