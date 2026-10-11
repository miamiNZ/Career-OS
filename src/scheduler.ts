import fs from "node:fs/promises";
import path from "node:path";
import { runAgents, type SearchOverrides } from "./orchestrator.js";
import { log } from "./logbus.js";
import type { PipelineSummary } from "./types.js";

/** Persisted across restarts so the dashboard can show the last run after a reboot,
 *  and so scheduler settings chosen in the Admin page survive a restart. */
const STATE_FILE = path.resolve(".career-os-state.json");

export type ScheduleMode = "daily" | "interval";

export interface SchedulerState {
  enabled: boolean;
  mode: ScheduleMode;
  time: string; // "HH:MM", local — used in daily mode
  intervalMinutes: number; // used in interval mode (e.g. 30 = every 30 min, 120 = every 2 h)
  nextRun: string | null; // ISO
  lastRun: string | null; // ISO
  lastResult: PipelineSummary | null;
  lastError: string | null; // last scheduled-run error (for dashboard notifications)
  running: boolean;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let loadedSettings = false; // true once persisted settings have been applied (they win over env)
const state: SchedulerState = {
  enabled: false,
  mode: "daily",
  time: "08:00",
  intervalMinutes: 60,
  nextRun: null,
  lastRun: null,
  lastResult: null,
  lastError: null,
  running: false,
};

/** ms from now until the next run, honouring the current mode. */
function msUntilNext(): number {
  if (state.mode === "interval") {
    return Math.max(1, Math.floor(state.intervalMinutes)) * 60_000;
  }
  // daily: next occurrence of HH:MM (today if still ahead, else tomorrow).
  const [h, m] = state.time.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h || 0, m || 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function describe(): string {
  if (!state.enabled) return "disabled";
  return state.mode === "interval"
    ? `every ${state.intervalMinutes} min, next ${state.nextRun}`
    : `daily at ${state.time}, next ${state.nextRun}`;
}

async function persist(): Promise<void> {
  try {
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          settings: {
            enabled: state.enabled,
            mode: state.mode,
            time: state.time,
            intervalMinutes: state.intervalMinutes,
          },
          lastRun: state.lastRun,
          lastResult: state.lastResult,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    // Best-effort persistence — a failed write must not break a run, but log it so a
    // permission/disk problem is visible rather than silently losing scheduler state.
    log("warn", `[scheduler] could not persist state to ${STATE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function load(): Promise<void> {
  try {
    const j = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    state.lastRun = j.lastRun ?? null;
    state.lastResult = j.lastResult ?? null;
    if (j.settings && typeof j.settings === "object") {
      state.enabled = !!j.settings.enabled;
      state.mode = j.settings.mode === "interval" ? "interval" : "daily";
      if (typeof j.settings.time === "string") state.time = j.settings.time;
      state.intervalMinutes = Number(j.settings.intervalMinutes) || state.intervalMinutes;
      loadedSettings = true;
    }
  } catch {
    /* no prior state */
  }
}

/** Run the pipeline immediately (also used by the dashboard “Search jobs” button).
 *  Optional overrides let a saved filter steer the search (sites/type/keywords). */
export async function runNow(overrides: SearchOverrides = {}): Promise<PipelineSummary> {
  if (state.running) throw new Error("Pipeline already running");
  state.running = true;
  state.lastError = null;
  try {
    const a = await runAgents(overrides);
    const summary: PipelineSummary = {
      ranAt: a.ranAt,
      ingested: a.found,
      found: a.found,
      enriched: a.enriched,
      scored: a.scored,
      kept: a.kept,
      rejected: a.rejected,
      duplicates: a.skippedDecided + a.skippedDropped + a.duplicatesDropped,
      reportFile: a.reportFile,
    };
    state.lastRun = summary.ranAt;
    state.lastResult = summary;
    await persist();
    return summary;
  } finally {
    state.running = false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!state.enabled) {
    state.nextRun = null;
    return;
  }
  const ms = msUntilNext();
  state.nextRun = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(async () => {
    try {
      await runNow();
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      console.error("[scheduler] run failed:", state.lastError);
    }
    schedule(); // re-arm (next interval / next day)
  }, ms);
}

export async function startScheduler(opts: { enabled: boolean; time: string }): Promise<void> {
  await load();
  // Persisted Admin-page settings win; otherwise fall back to env (SCHEDULE_*).
  if (!loadedSettings) {
    state.enabled = opts.enabled;
    state.time = opts.time;
  }
  schedule();
  console.log(`[scheduler] ${describe()}`);
}

/** Update scheduler settings at runtime (from the Admin page), re-arm, and persist. */
export async function setSchedule(opts: Partial<{
  enabled: boolean;
  mode: ScheduleMode;
  time: string;
  intervalMinutes: number;
}>): Promise<SchedulerState> {
  if (typeof opts.enabled === "boolean") state.enabled = opts.enabled;
  if (opts.mode === "daily" || opts.mode === "interval") state.mode = opts.mode;
  if (typeof opts.time === "string" && /^\d{1,2}:\d{2}$/.test(opts.time)) state.time = opts.time;
  if (opts.intervalMinutes != null) {
    state.intervalMinutes = Math.max(1, Math.floor(Number(opts.intervalMinutes) || 0));
  }
  schedule();
  await persist();
  console.log(`[scheduler] updated — ${describe()}`);
  return getSchedulerState();
}

export function getSchedulerState(): SchedulerState {
  return { ...state };
}

/**
 * Stop the scheduler and clear its pending timer. Called on graceful shutdown so a
 * long-lived process (dashboard) leaves no dangling setTimeout keeping the event loop
 * alive. Idempotent — safe to call when nothing is armed.
 */
export function stopScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  state.nextRun = null;
}
