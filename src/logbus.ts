// In-memory log bus + rotating file sink. Intercepts console.* into a ring buffer
// (for the dashboard LOGS panel) and, when LOG_DIR is set, also appends timestamped
// lines to a size-rotated file. Console still prints to the terminal — now prefixed
// with an ISO timestamp so `make docker-logs` / Unraid logs are time-stamped too.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error" | "debug";
export interface LogEntry {
  seq: number;
  ts: string; // ISO timestamp
  level: LogLevel;
  msg: string;
}

const MAX = 2000; // ring-buffer cap; oldest entries drop off
const buf: LogEntry[] = [];
let seq = 0;
let installed = false;

// -- Rotating file sink ------------------------------------------------------
// Enabled when LOG_DIR is set. The container image sets LOG_DIR=/logs; native runs
// stay console+buffer only unless you set LOG_DIR yourself (avoids writing C:\logs
// on Windows). Size-based rotation: career-os.log → .1 → .2 … up to LOG_MAX_FILES
// archives, dropping the oldest.
const LOG_DIR = process.env.LOG_DIR ?? "";
const LOG_FILE = LOG_DIR ? path.join(LOG_DIR, "career-os.log") : "";
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 5 * 1024 * 1024); // 5 MB
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES ?? 5);
let fileReady = false;

if (LOG_FILE) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    fileReady = true;
  } catch (e) {
    // Never let logging setup crash the app — fall back to console/buffer only.
    process.stderr.write(
      `[logbus] file logging disabled — cannot use LOG_DIR=${LOG_DIR}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

function rotateIfNeeded(): void {
  try {
    const size = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
    if (size < LOG_MAX_BYTES) return;
    // Shift archives down, dropping the oldest: .(n-1)→.n … .1→.2, then current→.1.
    for (let i = LOG_MAX_FILES; i >= 1; i--) {
      const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const dst = `${LOG_FILE}.${i}`;
      if (!existsSync(src)) continue;
      try {
        if (existsSync(dst)) unlinkSync(dst); // renameSync won't overwrite on Windows
        renameSync(src, dst);
      } catch {
        /* ignore a single failed shift */
      }
    }
  } catch {
    /* ignore */
  }
}

function writeFile(level: LogLevel, ts: string, msg: string): void {
  if (!fileReady) return;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, `${ts} [${level.toUpperCase()}] ${msg}\n`);
  } catch {
    /* never let logging crash the app */
  }
}

// -- Buffer + sink -----------------------------------------------------------

function push(level: LogLevel, args: unknown[]): void {
  const msg = args
    .map((a) =>
      typeof a === "string"
        ? a
        : a instanceof Error
          ? (a.stack ?? a.message)
          : safeStringify(a),
    )
    .join(" ");
  const ts = new Date().toISOString();
  buf.push({ seq: ++seq, ts, level, msg });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  writeFile(level, ts, msg);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Patch the global console so every log/warn/error is mirrored into the buffer +
 *  rotating file, and printed to the terminal with an ISO timestamp prefix. */
export function installLogBus(): void {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  const stamp = () => new Date().toISOString();
  console.log = (...a: unknown[]) => { push("info", a); orig.log(stamp(), ...a); };
  console.info = (...a: unknown[]) => { push("info", a); orig.info(stamp(), ...a); };
  console.warn = (...a: unknown[]) => { push("warn", a); orig.warn(stamp(), ...a); };
  console.error = (...a: unknown[]) => { push("error", a); orig.error(stamp(), ...a); };
  console.debug = (...a: unknown[]) => { push("debug", a); orig.debug(stamp(), ...a); };
}

/** Append a log line directly (for structured events not going through console).
 *  Goes to the dashboard buffer + rotating file, but NOT stdout. */
export function log(level: LogLevel, msg: string): void {
  push(level, [msg]);
}

/** Verbose gate for granular diagnostics (per-item, timings). On by default; set
 *  LOG_VERBOSE=0 to quiet it. */
export const VERBOSE = process.env.LOG_VERBOSE !== "0";

/**
 * Verbose stdout line — only emits when VERBOSE is on. Goes through console.log so
 * it lands in the terminal / container logs (where `log()` above, buffer+file only,
 * does not) and is mirrored into the dashboard buffer + file via the patched console.
 */
export function vlog(...args: unknown[]): void {
  if (VERBOSE) console.log(...args);
}

/** Entries with seq > since, oldest first. since=0 returns the whole buffer. */
export function getLogs(since = 0): LogEntry[] {
  return since ? buf.filter((e) => e.seq > since) : buf.slice();
}

export function clearLogs(): void {
  buf.length = 0;
}
