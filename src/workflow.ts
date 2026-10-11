import { JobSchema, type Job, type JobStatus, type Score } from "./types.js";
import { getJobNoteById, setJobStatus, setInterested, setAppliedDate } from "./vault.js";
import { applicationAgent } from "./agents/application.js";
import { convertBoth } from "./convert.js";
import { log } from "./logbus.js";
import { startTask, advanceTask, finishTask, failTask, TAILOR_STEPS } from "./activity.js";
import { requireOllama, releaseOllamaIfIdle, OllamaUnavailableError } from "./llm.js";

/**
 * Simplified job flow. career-os searches and tailors; it never submits.
 *   Opportunities (lead) → Interested → Application Ready (tailoring)
 * Any active job can be Dropped. Marking Interested kicks off local (Ollama)
 * resume + cover-letter generation.
 */
export const STATUS_FLOW: Record<JobStatus, JobStatus[]> = {
  lead: ["interested", "dropped"],
  interested: ["tailoring", "dropped"],
  tailoring: ["interested", "applied", "dropped"],
  applied: ["tailoring", "unsuccessful", "dropped"],
  // Applied but not successful — reactivate to Applied or send back to Opportunities.
  unsuccessful: ["applied", "lead", "dropped"],
  dropped: ["lead"],
  // Unused stages kept for type completeness (not shown on the board).
  interview: ["dropped"],
  offer: ["dropped"],
  rejected: [],
};

export function nextStatuses(from: JobStatus): JobStatus[] {
  return STATUS_FLOW[from] ?? [];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return nextStatuses(from).includes(to);
}

export interface ActionResult {
  ok: boolean;
  message: string;
  status?: JobStatus;
  /** Set when the action started background work the Activity screen can follow. */
  taskId?: string;
}

/** Guarded status move. */
async function transition(id: string, to: JobStatus): Promise<ActionResult> {
  const note = await getJobNoteById(id);
  if (!note) return { ok: false, message: `Job ${id} not found` };
  const from = (note.data.status ?? "lead") as JobStatus;
  if (from === to) return { ok: true, message: `Already ${to}`, status: to };
  if (!canTransition(from, to)) return { ok: false, message: `Can't move ${from} → ${to}` };
  await setJobStatus(id, to);
  return { ok: true, message: `${from} → ${to}`, status: to };
}

/** Drop a job from any active stage. Unticks the Interested checkbox. */
export async function dropJob(id: string): Promise<ActionResult> {
  await setInterested(id, false);
  return transition(id, "dropped");
}

/** Manual guarded move (per-card status dropdown). */
export const setStatus = (id: string, to: JobStatus): Promise<ActionResult> => transition(id, to);

/**
 * Mark a job Applied and record the date you applied. Writes `applied: <date>`
 * to the note frontmatter and advances the status to "applied".
 */
export async function markApplied(id: string, date?: string): Promise<ActionResult> {
  const note = await getJobNoteById(id);
  if (!note) return { ok: false, message: `Job ${id} not found` };
  const from = (note.data.status ?? "lead") as JobStatus;
  if (from !== "applied" && !canTransition(from, "applied")) {
    return { ok: false, message: `Can't move ${from} → applied` };
  }
  // Default to today (local) as YYYY-MM-DD; accept an explicit date from the UI.
  const when = isValidDate(date) ? date! : new Date().toISOString().slice(0, 10);
  await setAppliedDate(id, when);
  await setJobStatus(id, "applied");
  return { ok: true, status: "applied", message: `Marked applied on ${when}` };
}

function isValidDate(s?: string): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Mark a job Interested: tick the Obsidian checkbox, then generate a tailored resume +
 * cover letter with the local model and advance to "Application Ready".
 *
 * The tailoring runs in the BACKGROUND and this returns as soon as the note is flipped to
 * Interested. It used to be awaited inside the HTTP request, which was tolerable when the
 * whole pipeline took ~60s; with a 32B model reasoning over a full master resume it runs for
 * many minutes, and a request held open that long looks — to the browser and to the user —
 * exactly like a hung app. Progress is published to the task registry instead, so the
 * Activity screen can show which step it is on and roughly how long is left.
 */
export async function markInterested(id: string): Promise<ActionResult> {
  const note = await getJobNoteById(id);
  if (!note) return { ok: false, message: `Job ${id} not found` };

  const title = String(note.data.title ?? id);

  // Gate before touching the note. Tailoring without the model writes untailored master
  // copies and still advances the job to Application Ready — a finished-looking application
  // that was never tailored to the job at all. Refuse instead, and leave the note exactly
  // as it was so the click can simply be repeated once Ollama is up.
  try {
    await requireOllama("Tailoring this application");
  } catch (e) {
    if (!(e instanceof OllamaUnavailableError)) throw e;
    log("error", e.message);
    return { ok: false, message: e.message };
  }

  log("info", `▶ Marked Interested: "${title}" — starting tailoring pipeline`);
  await setJobStatus(id, "interested");
  await setInterested(id, true);

  const job = await jobFromNote(id);
  if (!job) {
    log("warn", `"${title}" is missing fields needed to tailor — left in Interested`);
    return { ok: false, message: "Marked interested, but note is missing fields to tailor", status: "interested" };
  }

  const task = startTask("tailor", title, String(note.data.company ?? ""), TAILOR_STEPS);
  // Deliberately not awaited: the caller gets the task id and follows it on the Activity
  // screen. Every path inside settles the task, so it can never sit "running" forever.
  void runTailoring(id, title, job, note.data, task.id);
  return {
    ok: true,
    status: "interested",
    message: "Tailoring started — follow it on the Activity screen",
    taskId: task.id,
  };
}

/** The long half of markInterested, run as a tracked background task. */
async function runTailoring(
  id: string,
  title: string,
  job: Job,
  noteData: Record<string, unknown>,
  taskId: string,
): Promise<ActionResult> {
  try {
    const docs = await applicationAgent(job, scoreFromNote(id, noteData), taskId, {
      // Ollama was up at the gate; `requireLlm` covers it dying mid-task. Without it the
      // agent quietly swaps in untailored master copies and the job still lands in
      // Application Ready, which reads as a finished application and is not one.
      requireLlm: true,
    });

    const quality = "Tailored + reviewed";

    advanceTask(taskId, 4);
    const conv = await convertBoth(id, "docx");
    await setJobStatus(id, "tailoring");

    if (conv.files.length === 2) {
      log("info", `✓ "${title}" → Application Ready — ${docs.tailored ? "tailored; " : "master copies; "}resume.docx + cover-letter.docx generated`);
      finishTask(taskId, `${quality} + .docx generated`);
      return { ok: true, status: "tailoring", message: `${quality} + .docx generated — moved to Application Ready` };
    }
    if (conv.wordUnavailable) {
      log("warn", "Microsoft Word not available — .docx skipped; markdown is ready");
      finishTask(taskId, `${quality} — .docx skipped (Word not installed)`);
      return { ok: true, status: "tailoring", message: `${quality} — moved to Application Ready (.docx skipped: Word not installed)` };
    }
    const made = conv.files.length;
    log("warn", `.docx export partial (${made}/2) — ${conv.errors.join("; ")}`);
    finishTask(taskId, `${quality} — ${made}/2 .docx generated`);
    return { ok: true, status: "tailoring", message: `${quality} — moved to Application Ready (${made}/2 .docx generated)` };
  } catch (e) {
    log("error", `Tailoring failed for "${title}": ${errMsg(e)}`);
    failTask(taskId, errMsg(e));
    return { ok: false, message: `Marked interested, tailoring failed: ${errMsg(e)}`, status: "interested" };
  } finally {
    // Free the ~15GB the model holds once this task is done — unless another tailoring run
    // is still mid-call, in which case that one unloads when it finishes.
    await releaseOllamaIfIdle();
  }
}

/** Rebuild a typed Job from a persisted note. Pulls the real description section. */
async function jobFromNote(id: string): Promise<Job | null> {
  const note = await getJobNoteById(id);
  if (!note) return null;
  const d = note.data;
  const parsed = JobSchema.safeParse({
    id: d.id,
    source: d.source,
    title: d.title,
    company: d.company || undefined,
    location: d.location || undefined,
    url: d.url,
    salaryText: d.salary || undefined,
    engagement: d.engagement ?? "unknown",
    employmentType: d.employmentType ?? "unknown",
    workArrangement: d.workArrangement ?? "unknown",
    description: descriptionFromBody(note.body),
    ingestedAt: d.ingested ?? new Date().toISOString(),
  });
  if (!parsed.success) {
    log("warn", `Can't tailor — note fields invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return null;
  }
  return parsed.data;
}

/** Extract the text under the "## Description" heading, ignoring the checkbox/meta header. */
function descriptionFromBody(body: string): string {
  const i = body.indexOf("## Description");
  const text = i >= 0 ? body.slice(i + "## Description".length) : body;
  return text.trim();
}

function scoreFromNote(id: string, d: Record<string, any>): Score | undefined {
  if (typeof d.fit !== "number") return undefined;
  return {
    jobId: id,
    fit: d.fit,
    rejected: !!d.autoRejected,
    rejectReasons: d.rejectReasons ?? [],
    matchedSkills: d.matched ?? [],
    missingSkills: d.missing ?? [],
    rationale: d.rationale ?? "",
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
