/**
 * Configuration constants for Cursor Remote Extension
 */

export const CONFIG = {
  // WebSocket server port
  WEBSOCKET_PORT: 8766,

  // Relay server URL
  RELAY_SERVER_URL: process.env.RELAY_SERVER_URL || "https://cursor-remote-rela.vercel.app",

  // CDP (Existing Cursor Agent) — localhost only
  ENABLE_CDP:
    String(process.env.ENABLE_CDP || "").toLowerCase() === "true" ||
    process.env.ENABLE_CDP === "1",
  CDP_HOST: process.env.CDP_HOST || "127.0.0.1",
  CDP_PORT: Number(process.env.CDP_PORT || 9222),
  CDP_POLL_INTERVAL_MS: Number(process.env.CDP_POLL_INTERVAL_MS || 1000),

  // File paths
  TERMINAL_OUTPUT_FILE: ".cursor-remote-terminal-output.log",

  // Timeouts (in milliseconds)
  TERMINAL_FOCUS_DELAY: 500,
  TERMINAL_EXECUTION_DELAY: 500,

  // Command patterns
  COMMAND_PATTERNS: [
    /^[a-z]+-[a-z]+/i,
    /^[a-z]+\.[a-z]+/i,
    /^[a-z]+:[a-z]+/i,
  ],

  // Plain text patterns (not commands)
  PLAIN_TEXT_PATTERNS: [/^hello\s*$/i, /^hi\s*$/i, /^hey\s*$/i],
} as const;
