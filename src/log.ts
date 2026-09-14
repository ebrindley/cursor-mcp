/**
 * stderr-only logging.
 *
 * stdout is the JSON-RPC channel under the stdio transport. Writing anything
 * there corrupts the protocol stream, so this module never touches it and
 * nothing else in the server may call console.log.
 */

import { capBytes, sanitize } from "./untrusted.js";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): number {
  const raw = (process.env.CURSOR_MCP_LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

function emit(level: Level, message: string): void {
  if (ORDER[level] < threshold()) return;
  const safe = capBytes(sanitize(message).replace(/\s+/g, " ").trim(), 2_048).text;
  process.stderr.write(`[cursor-mcp] ${level}: ${safe}\n`);
}

export const log = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
