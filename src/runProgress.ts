/**
 * Live progress for a search run.
 *
 * A run takes minutes (four job boards, a second HTTP call per listing, then one local
 * model call per new job). The dashboard used to show nothing but a disabled button for
 * that whole time, so a slow run was indistinguishable from a hung one. The pipeline
 * publishes its phase here and the board polls it, so the user can see that
 * opportunities are being retrieved and how many have been found so far.
 *
 * Module-level state on purpose: one process, one pipeline at a time (the scheduler
 * refuses a concurrent run), and every dashboard tab should see the same run — including
 * one the scheduler started with nobody watching.
 */

export type RunPhase =
  | "idle"
  | "starting"
  | "searching"
  | "describing"
  | "filtering"
  | "scoring"
  | "finishing"
  | "done"
  | "error";

export interface RunProgress {
  /** Sequence number, bumped on every start — lets a client spot a new run. */
  seq: number;
  running: boolean;
  phase: RunPhase;
  /** Human line for the banner, e.g. "Scoring 12 of 37 new opportunities…". */
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Unique listings the search returned (after cross-site de-dupe). */
  found: number;
  /** Per-site counts/errors, mirrored from the search agents. */
  bySite: Record<string, { count: number; error?: string }>;
  /** Jobs with no note yet — the ones that actually need scoring. */
  newJobs: number;
  scored: number;
  toScore: number;
  kept: number;
  /** Listings skipped or dropped because the board already holds the role. */
  duplicates: number;
  error: string | null;
}

const initial = (): RunProgress => ({
  seq: 0,
  running: false,
  phase: "idle",
  message: "",
  startedAt: null,
  finishedAt: null,
  found: 0,
  bySite: {},
  newJobs: 0,
  scored: 0,
  toScore: 0,
  kept: 0,
  duplicates: 0,
  error: null,
});

let state: RunProgress = initial();

/** Reset to a fresh running state. Keeps the seq counter climbing. */
export function startRun(): void {
  const seq = state.seq + 1;
  state = {
    ...initial(),
    seq,
    running: true,
    phase: "starting",
    message: "Retrieving opportunities…",
    startedAt: new Date().toISOString(),
  };
}

/** Merge a phase update into the current run (no-op once the run has finished). */
export function updateRun(patch: Partial<RunProgress>): void {
  if (!state.running) return;
  state = { ...state, ...patch };
}

/** Mark the run finished and record its headline numbers. */
export function finishRun(patch: Partial<RunProgress> = {}): void {
  state = {
    ...state,
    ...patch,
    running: false,
    phase: "done",
    finishedAt: new Date().toISOString(),
    error: null,
    message: summarize({ ...state, ...patch }),
  };
}

/** Mark the run failed, keeping whatever counts it reached. */
export function failRun(error: string): void {
  state = {
    ...state,
    running: false,
    phase: "error",
    finishedAt: new Date().toISOString(),
    error,
    message: `Search failed: ${error}`,
  };
}

export function getRunProgress(): RunProgress {
  return { ...state, bySite: { ...state.bySite } };
}

/** Final banner line: what was found, what landed, what was skipped as already-seen. */
function summarize(p: RunProgress): string {
  const parts = [`Found ${p.found} opportunit${p.found === 1 ? "y" : "ies"}`];
  parts.push(`${p.kept} kept`);
  if (p.duplicates) parts.push(`${p.duplicates} already on the board`);
  return parts.join(" · ");
}

/** Test hook — clears the module state between cases. */
export function resetRunProgress(): void {
  state = initial();
}
