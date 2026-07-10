/**
 * In-memory ring buffer of recent console output, surfaced on the /logs page.
 * Wraps console.log/warn/error once at process start; everything the engine,
 * poller and judge print is kept (last MAX lines) alongside normal stdout.
 * Memory-only by design — restarting the app clears it.
 */

export interface LogLine {
  ts: number;
  level: "log" | "warn" | "error";
  text: string;
}

const MAX = 1000;
const buf: LogLine[] = [];
let installed = false;

function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function initLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      orig(...args);
      buf.push({ ts: Date.now(), level, text: args.map(fmt).join(" ") });
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    };
  }
}

export function recentLogs(): readonly LogLine[] {
  return buf;
}
