/**
 * Live registry of long-running work, so the dashboard can show what the app is doing.
 *
 * Two things in Career-OS take minutes with no visible sign of life: a search run (four job
 * boards, a description fetch per listing, then a local model call per new job) and tailoring
 * one application (four model calls, each of which can run for minutes on a 32B model that is
 * mostly offloaded to CPU). The search run already publishes phases to runProgress; tailoring
 * published nothing at all, so clicking Interested looked identical to a hung app.
 *
 * This holds the tailoring side and anything else task-shaped. The search run stays in
 * runProgress — it is a singleton with its own richer shape — and `/api/activity` merges the
 * two into one list for the Activity screen.
 *
 * Module-level state on purpose, exactly as runProgress does it: one process, and every
 * dashboard tab should see the same work, including work the scheduler started with nobody
 * watching.
 */

/** What kind of work this is. Drives the icon and the label on the Activity screen. */
export type TaskKind = "tailor" | "search" | "convert";

export type TaskState = "queued" | "running" | "done" | "error" | "cancelled";

export interface TaskStep {
  /** Short label shown while this step is the active one, e.g. "Writing cover letter". */
  label: string;
  /** Relative cost, used to weight the progress bar. A step that takes 4x as long gets 4. */
  weight: number;
}

export interface Task {
  id: string;
  /**
   * Monotonic creation order. Sorting by `startedAt` looks equivalent but is not: two tasks
   * created in the same millisecond compare equal and the order becomes arbitrary, which on a
   * fast machine means the Activity list can shuffle between polls.
   */
  seq: number;
  kind: TaskKind;
  /** Primary line — the job title, or what the run is doing. */
  title: string;
  /** Secondary line — company, or the sites being searched. */
  subtitle: string;
  state: TaskState;
  /** Index into `steps` of the step currently running. */
  stepIndex: number;
  steps: TaskStep[];
  /** 0..1. Weighted by step cost, so the bar does not jump. */
  progress: number;
  startedAt: string;
  finishedAt: string | null;
  /** Seconds remaining, estimated from elapsed time and progress. Null until measurable. */
  etaSeconds: number | null;
  message: string;
  error: string | null;
  /** Set by a cancel request; the task loop checks it between steps and stops. */
  cancelRequested: boolean;
}

/**
 * How many finished tasks to keep. The Activity screen shows recent history so a run that
 * completed while you were on another page is not invisible — but this is a live view, not
 * an audit log, so it stays small and in memory.
 */
const MAX_TASKS = 50;

const tasks = new Map<string, Task>();
let counter = 0;

/** The steps a tailoring run works through, weighted by how long each actually takes. */
export const TAILOR_STEPS: TaskStep[] = [
  { label: "Re-focusing skills", weight: 1 },
  { label: "Re-ordering highlights", weight: 1 },
  { label: "Re-angling the summary", weight: 4 },
  { label: "Writing the cover letter", weight: 6 },
  { label: "Generating .docx", weight: 1 },
];

function totalWeight(steps: TaskStep[]): number {
  return steps.reduce((sum, s) => sum + s.weight, 0) || 1;
}

/**
 * Fraction complete once `stepIndex` steps have finished. Weighted rather than
 * `index / length`: the two model-written documents dominate the wall clock, so an
 * unweighted bar would sit at 40% for the fast steps and then crawl.
 */
function weightedProgress(steps: TaskStep[], stepIndex: number): number {
  const done = steps.slice(0, stepIndex).reduce((sum, s) => sum + s.weight, 0);
  return Math.min(1, done / totalWeight(steps));
}

/** Seconds remaining, extrapolated from how long the completed fraction took. */
function estimateEta(startedAt: string, progress: number): number | null {
  if (progress <= 0.02 || progress >= 1) return null;
  const elapsed = (Date.now() - Date.parse(startedAt)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.max(0, Math.round(elapsed / progress - elapsed));
}

/** Drop the oldest finished tasks once the map outgrows MAX_TASKS. Running work is kept. */
function prune(): void {
  if (tasks.size <= MAX_TASKS) return;
  const finished = [...tasks.values()]
    .filter((t) => t.state !== "running" && t.state !== "queued")
    .sort((a, b) => Date.parse(a.finishedAt ?? a.startedAt) - Date.parse(b.finishedAt ?? b.startedAt));
  for (const t of finished) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(t.id);
  }
}

export function startTask(
  kind: TaskKind,
  title: string,
  subtitle: string,
  steps: TaskStep[],
): Task {
  const seq = ++counter;
  const id = `${kind}-${seq}-${Date.now().toString(36)}`;
  const task: Task = {
    id,
    seq,
    kind,
    title,
    subtitle,
    state: "running",
    stepIndex: 0,
    steps,
    progress: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    etaSeconds: null,
    message: steps[0]?.label ?? "",
    error: null,
    cancelRequested: false,
  };
  tasks.set(id, task);
  prune();
  return task;
}

/** Advance to step `index`, recomputing the bar and the ETA. */
export function advanceTask(id: string, index: number, message?: string): void {
  const t = tasks.get(id);
  if (!t || t.state !== "running") return;
  t.stepIndex = Math.max(0, Math.min(index, t.steps.length));
  t.progress = weightedProgress(t.steps, t.stepIndex);
  t.etaSeconds = estimateEta(t.startedAt, t.progress);
  t.message = message ?? t.steps[t.stepIndex]?.label ?? t.message;
}

export function finishTask(id: string, message: string): void {
  const t = tasks.get(id);
  if (!t) return;
  t.state = t.state === "cancelled" ? "cancelled" : "done";
  t.stepIndex = t.steps.length;
  t.progress = 1;
  t.etaSeconds = 0;
  t.finishedAt = new Date().toISOString();
  t.message = message;
}

export function failTask(id: string, error: string): void {
  const t = tasks.get(id);
  if (!t) return;
  t.state = "error";
  t.finishedAt = new Date().toISOString();
  t.error = error;
  t.message = error;
}

/**
 * Ask a task to stop. Cooperative: the work checks `isCancelled` between steps, so a model
 * call already in flight still has to return before the task actually ends. Nothing here can
 * abort a running inference — pretending otherwise would leave the UI lying about the state.
 */
export function cancelTask(id: string): boolean {
  const t = tasks.get(id);
  if (!t) return false;
  if (t.state !== "running" && t.state !== "queued") {
    // Already finished — treat a cancel as "clear it from the list".
    tasks.delete(id);
    return true;
  }
  t.cancelRequested = true;
  t.state = "cancelled";
  t.message = "Cancelling after the current step…";
  return true;
}

/** True once a cancel has been requested. Call between steps in a long task. */
export function isCancelled(id: string): boolean {
  return tasks.get(id)?.cancelRequested === true;
}

/** Remove one finished task from the list (the row's × button). */
export function dismissTask(id: string): boolean {
  const t = tasks.get(id);
  if (!t || t.state === "running" || t.state === "queued") return false;
  tasks.delete(id);
  return true;
}

/** Newest first, with ETAs recomputed so a polled list stays honest between updates. */
export function listTasks(): Task[] {
  return [...tasks.values()]
    .map((t) => (t.state === "running" ? { ...t, etaSeconds: estimateEta(t.startedAt, t.progress) } : { ...t }))
    .sort((a, b) => b.seq - a.seq);
}

/** Test hook — clears the registry between cases. */
export function resetTasks(): void {
  tasks.clear();
  counter = 0;
}
