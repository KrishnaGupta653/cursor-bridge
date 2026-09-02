export * from "./cdp-types";
export * from "./cdp-client";
export * from "./cursor-target";
export * from "./cursor-session";
export * from "./cdp-manager";

/** Logical aliases matching the control-center architecture. */
export { rankTargets as discoverCursorTargets } from "./cursor-target";
export { CdpManager as CursorSessionManager } from "./cdp-manager";
export { CursorSession as CursorAgentMonitor } from "./cursor-session";
