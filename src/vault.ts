import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { vault } from "./config.js";
import { mapLimit } from "./concurrency.js";
import type { AppliedHistoryEntry, Job, JobStatus, Profile, Score } from "./types.js";

async function readSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Transient write failures on the vault. The vault normally lives on an SMB share
 * (`\\nas\appdata\...`), where a note can be briefly unopenable because Obsidian, a
 * sync client, or an indexer holds it — surfacing as EPERM/EBUSY rather than a lock error.
 * A search run writes hundreds of notes, so hitting one of these is routine and must not
 * be treated as fatal.
 */
const TRANSIENT_WRITE_ERRORS = new Set(["EPERM", "EBUSY", "EACCES", "EMFILE", "UNKNOWN"]);
const WRITE_RETRIES = 4;
const WRITE_BACKOFF_MS = 250;

const errCode = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";

/**
 * One write at a time per file. A run writes notes concurrently now, and a note's
 * filename is derived from company + title — so two listings of the same role at the same
 * employer, arriving under different ids from different boards, target the same file.
 * Serialising by path keeps the last writer's content intact instead of racing it, and
 * keeps the note cache in step with what is actually on disk.
 */
const writeQueue = new Map<string, Promise<unknown>>();

/**
 * Write a vault file, retrying with backoff while the failure looks like a transient
 * share lock. Throws the last error once the retries are exhausted or the failure is
 * something a retry cannot fix (bad path, disk full).
 */
function writeFileRetry(file: string, content: string): Promise<void> {
  const key = path.resolve(file).toLowerCase();
  // Chain onto whatever is already writing this file; a failed write must not break the
  // chain for the next writer, hence the swallowed catch on the predecessor.
  const run = (writeQueue.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeFileNow(file, content));
  writeQueue.set(key, run);
  return run.finally(() => {
    // Last writer out clears the slot so the map doesn't grow for the process's lifetime.
    if (writeQueue.get(key) === run) writeQueue.delete(key);
  });
}

async function writeFileNow(file: string, content: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, content, "utf8");
      // Push the content we just wrote into the note cache instead of invalidating it.
      // A status change would otherwise force the next read to re-scan the whole share.
      cacheWrittenNote(file, content);
      return;
    } catch (e) {
      if (attempt >= WRITE_RETRIES || !TRANSIENT_WRITE_ERRORS.has(errCode(e))) throw e;
      await new Promise((r) => setTimeout(r, WRITE_BACKOFF_MS * (attempt + 1)));
    }
  }
}

/** Load the user's profile from Career/Profile + Resume + Supporting. */
export async function loadProfile(): Promise<Profile> {
  const [skills, experience, education, preferences, resumeMaster, coverLetterTemplate, coverFallback] =
    await Promise.all([
      readSafe(path.join(vault.profileDir, "skills.md")),
      readSafe(path.join(vault.profileDir, "experience.md")),
      readSafe(path.join(vault.profileDir, "education.md")),
      readSafe(path.join(vault.profileDir, "preferences.md")),
      readSafe(vault.resumeMaster),
      readSafe(vault.coverLetterTemplate),
      readSafe(vault.coverLetterFallback),
    ]);
  return { skills, experience, education, preferences, resumeMaster, coverLetterTemplate, coverFallback };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Short NZ day label for an ISO date, e.g. "2 Jul 2026"; "—" when missing/unparseable. */
function fmtDay(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

function employmentLabel(t: Job["employmentType"]): string {
  const map: Record<Job["employmentType"], string> = {
    "full-time": "Full-time",
    "part-time": "Part-time",
    contract: "Contract / temp",
    casual: "Casual",
    unknown: "",
  };
  return map[t] ?? "";
}

/** Write one Job note into Career/Jobs/. Skips if a note for the id already exists. */
export async function writeJobNote(
  job: Job,
  status: JobStatus,
  extra: Record<string, unknown> = {},
): Promise<string> {
  await fs.mkdir(vault.jobsDir, { recursive: true });
  // Fall back to source when company is blank (LinkedIn often is) so the filename
  // never collapses to "-title.md" and collide across different jobs.
  const name = `${slug(job.company || job.source)}-${slug(job.title)}.md`;
  // Match an existing note by its frontmatter id, not its filename: a later run
  // can learn the company (changing the slug), and we must update the same note
  // rather than spawn a duplicate.
  const file = (await findNoteFileById(job.id)) ?? path.join(vault.jobsDir, name);

  // If the note already exists, preserve the user's state (status / Interested
  // checkbox / generated docs) but still refresh the Description with a fuller
  // one when a later run fetches more text from the listing.
  const prior = await readSafe(file);
  if (prior.trim()) {
    const newDesc = (job.description || "").trim();
    const cur = matter(prior);
    // Backfill metadata that older notes never captured (keeps user state intact).
    cur.data.employmentType = job.employmentType;
    cur.data.workArrangement = job.workArrangement;
    // Extras are backfilled too, but never overwrite what the note already says: `track`
    // records which search found the role, and a role already claimed by one track should
    // not be relabelled by the next one that happens to return it.
    for (const [k, v] of Object.entries(extra)) if (cur.data[k] === undefined) cur.data[k] = v;
    if (!cur.data.salary && job.salaryText) cur.data.salary = job.salaryText;
    if (job.postedAt) cur.data.posted = job.postedAt;
    if (job.closesAt) cur.data.closes = job.closesAt;
    const i = cur.content.indexOf("## Description");
    const existingDesc = i >= 0 ? cur.content.slice(i + "## Description".length).trim() : "";
    const head = i >= 0 ? cur.content.slice(0, i) : cur.content + "\n\n";
    const desc = newDesc.length > existingDesc.length ? newDesc : existingDesc;
    await writeFileRetry(file, matter.stringify(`${head}## Description\n\n${desc}\n`, cur.data));
    return file;
  }

  const front = {
    type: "job",
    id: job.id,
    status,
    source: job.source,
    company: job.company ?? "",
    title: job.title,
    location: job.location ?? "",
    url: job.url,
    salary: job.salaryText ?? "",
    engagement: job.engagement,
    employmentType: job.employmentType,
    workArrangement: job.workArrangement,
    posted: job.postedAt ?? "",
    closes: job.closesAt ?? "",
    ingested: job.ingestedAt,
    ...extra,
  };

  const badges = [
    employmentLabel(job.employmentType),
    job.workArrangement !== "unknown" ? cap(job.workArrangement) : "",
  ].filter(Boolean).join("  ·  ");

  const body = [
    `# ${job.title}${job.company ? ` — ${job.company}` : ""}`,
    "",
    `- [ ] Interested`,
    "",
    `**Source:** ${job.source}  ·  **Location:** ${job.location ?? "—"}  ·  **Salary:** ${job.salaryText ?? "—"}`,
    ...(badges ? [`**Type:** ${badges}`] : []),
    ...(job.postedAt || job.closesAt
      ? [`**Posted:** ${fmtDay(job.postedAt)}  ·  **Closes:** ${fmtDay(job.closesAt)}`]
      : []),
    "",
    `[View posting](${job.url})`,
    "",
    "## Description",
    "",
    job.description || "_(not captured)_",
  ].join("\n");

  await writeFileRetry(file, matter.stringify(body, front));
  return file;
}

/** Locate the note file whose frontmatter id matches, or null. */
async function findNoteFileById(id: string): Promise<string | null> {
  return (await getJobNoteById(id))?.file ?? null;
}

/**
 * Remove duplicate job notes that share the same frontmatter id (a pre-fix bug
 * spawned a second file when a job's company became known). Keeps the note with
 * the longest "## Description" and the most useful status, deletes the rest.
 */
export async function dedupeNoteFilesById(): Promise<{ removed: number }> {
  const byId = new Map<string, { file: string; descLen: number; active: boolean }[]>();
  for (const n of await listJobNotes()) {
    const id = n.data.id;
    if (typeof id !== "string" || !id) continue;
    const i = n.body.indexOf("## Description");
    const desc = i >= 0 ? n.body.slice(i + "## Description".length).replace(/_\(.*?\)_/g, "").trim() : "";
    const status = (n.data.status ?? "lead") as JobStatus;
    const arr = byId.get(id) ?? [];
    arr.push({ file: n.file, descLen: desc.length, active: status !== "dropped" && status !== "rejected" });
    byId.set(id, arr);
  }
  let removed = 0;
  for (const [id, arr] of byId) {
    if (arr.length < 2) continue;
    // Best note: prefer active, then longest description.
    arr.sort((a, b) => Number(b.active) - Number(a.active) || b.descLen - a.descLen);
    for (const dup of arr.slice(1)) {
      await fs.rm(dup.file, { force: true });
      forgetNote(dup.file);
      removed++;
      console.log(`[dedupe-files] removed duplicate note for id=${id}: ${path.basename(dup.file)}`);
    }
  }
  if (removed) console.log(`[dedupe-files] done — ${removed} duplicate note file(s) removed`);
  return { removed };
}

/** Read all existing job ids from Career/Jobs/ for dedupe. */
export async function existingJobIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const n of await listJobNotes()) {
    if (typeof n.data.id === "string") ids.add(n.data.id);
  }
  return ids;
}

// --- Dashboard store: read + update job notes / reports ----------------------

/** A parsed job note: frontmatter data + markdown body + absolute path. */
export interface JobNote {
  file: string;
  data: Record<string, any>;
  body: string;
}

async function readJobNote(file: string): Promise<JobNote> {
  const raw = await readSafe(file);
  try {
    const fm = matter(raw);
    return { file, data: fm.data, body: fm.content };
  } catch (e) {
    // Malformed YAML frontmatter (hand-edited in Obsidian) used to throw all the way out
    // of listJobNotes and blank the whole board. Skip the one bad note instead.
    console.warn(`[vault] unreadable frontmatter in ${path.basename(file)} — skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { file, data: {}, body: raw };
  }
}

/**
 * The vault normally lives on an SMB share, where every file open is a network
 * round-trip: reading the ~560 notes one at a time takes ~22s, and a dashboard state
 * build used to do that four times over. Two fixes, both here:
 *
 *  - read the notes concurrently (~2-4s for the same directory), and
 *  - keep the parsed result in memory for CACHE_TTL_MS so the several reads a single
 *    request makes collapse into one scan, with an in-flight promise shared by
 *    concurrent callers.
 *
 * The cache is written through on every note write (see writeFileRetry), so our own
 * mutations are visible immediately; an edit made in Obsidian shows up on the next
 * scan, at most CACHE_TTL_MS later. Set VAULT_CACHE_TTL_MS=0 to disable (tests do).
 */
const NOTE_READ_CONCURRENCY = 64;
// Comfortably under the dashboard's 30s auto-refresh, so a poll still triggers at most one
// background re-scan, but a burst of requests (several screens, a card action) doesn't.
const CACHE_TTL_MS = Number(process.env.VAULT_CACHE_TTL_MS ?? 15_000);

let noteCache = new Map<string, JobNote>();
let noteCacheAt = 0;
let noteScan: Promise<Map<string, JobNote>> | null = null;

/** Job-note filenames only: skips templates (_*) and the Job Opportunities.md index. */
function isJobNoteFile(name: string): boolean {
  return name.endsWith(".md") && !name.startsWith("_") && name !== "Job Opportunities.md";
}

/** A real job note always carries a frontmatter id — stray/scratch markdown is not one. */
function hasNoteId(note: JobNote): boolean {
  return !!note.data && !!String(note.data.id ?? "").trim();
}

/** Record a note we just wrote, so the cache never goes stale behind our own writes. */
function cacheWrittenNote(file: string, content: string): void {
  if (path.dirname(file) !== vault.jobsDir || !isJobNoteFile(path.basename(file))) return;
  const fm = matter(content);
  const note: JobNote = { file, data: fm.data, body: fm.content };
  if (hasNoteId(note)) noteCache.set(file, note);
}

/** Forget a note we just deleted. */
function forgetNote(file: string): void {
  noteCache.delete(file);
}

/** Drop the cached notes so the next read re-scans the vault from disk. */
export function invalidateJobNoteCache(): void {
  noteCache = new Map();
  noteCacheAt = 0;
}

async function scanJobNotes(): Promise<Map<string, JobNote>> {
  let files: string[];
  try {
    files = await fs.readdir(vault.jobsDir);
  } catch {
    return new Map();
  }
  const paths = files.filter(isJobNoteFile).map((f) => path.join(vault.jobsDir, f));
  const notes = await mapLimit(paths, NOTE_READ_CONCURRENCY, readJobNote);
  const next = new Map<string, JobNote>();
  for (const n of notes) if (hasNoteId(n)) next.set(n.file, n);
  return next;
}

/** Start (or join) the single in-flight vault scan. */
function startScan(): Promise<Map<string, JobNote>> {
  if (!noteScan) {
    noteScan = scanJobNotes()
      .then((m) => {
        noteCache = m;
        noteCacheAt = Date.now();
        return m;
      })
      .finally(() => {
        noteScan = null;
      });
    // A background refresh has no awaiter — keep a failure from becoming an
    // unhandled rejection. Blocking callers still see the error via their await.
    noteScan.catch(() => {});
  }
  return noteScan;
}

/** Read every job note in Career/Jobs/ (excludes the _template). */
export async function listJobNotes(): Promise<JobNote[]> {
  if (CACHE_TTL_MS <= 0) return [...(await startScan()).values()];
  if (Date.now() - noteCacheAt < CACHE_TTL_MS) return [...noteCache.values()];
  const scan = startScan();
  // Stale-while-revalidate. Once a copy exists, hand it back and let the re-scan land in
  // the background: the dashboard's 30s poll then never waits on the share, and our own
  // writes are already in the cache (writeFileRetry writes through). A note edited in
  // Obsidian shows up one poll later.
  if (noteCacheAt > 0) return [...noteCache.values()];
  return [...(await scan).values()];
}

/** Find a job note by its stable id. */
export async function getJobNoteById(id: string): Promise<JobNote | undefined> {
  const notes = await listJobNotes();
  return notes.find((n) => n.data.id === id);
}

/** Load → mutate frontmatter → write back, preserving the markdown body. */
async function updateJobNote(
  file: string,
  mutate: (data: Record<string, any>) => void,
): Promise<void> {
  const note = await readJobNote(file);
  mutate(note.data);
  await writeFileRetry(file, matter.stringify(note.body, note.data));
}

/** Persist a Score onto the job note frontmatter so the board can rank it. */
export async function setJobScore(id: string, score: Score): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  await updateJobNote(note.file, (d) => {
    d.fit = score.fit;
    d.autoRejected = score.rejected;
    d.rejectReasons = score.rejectReasons;
    d.rationale = score.rationale;
    d.matched = score.matchedSkills;
    d.missing = score.missingSkills;
    d.scored = new Date().toISOString();
    // Which resume + which model produced this number. Lets `rescore --stale` find the
    // notes scored against an older you instead of re-running the whole board.
    if (score.profileHash) d.profileHash = score.profileHash;
    if (score.scorer) d.scorer = score.scorer;
  });
  return true;
}

/** Set a job note's status by id. Transition rules live in workflow.ts (caller enforces). */
export async function setJobStatus(id: string, status: JobStatus): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  await updateJobNote(note.file, (d) => {
    d.status = status;
    d.statusChanged = new Date().toISOString();
  });
  return true;
}

/** Record the date the user applied (YYYY-MM-DD) onto the note frontmatter. */
export async function setAppliedDate(id: string, date: string): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  await updateJobNote(note.file, (d) => {
    d.applied = date;
  });
  return true;
}

/** Same slug the application agent uses for its Career/Jobs/Applications/<slug> folder. */
const appSlugPart = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile the board with the Applications folder: if a job is in "tailoring"
 * (Application Ready) but its generated docs folder has been deleted, move it
 * back to Opportunities and untick Interested. Lets the user drop an application
 * just by deleting its folder in Obsidian. Returns how many were reverted.
 */
export async function reconcileApplications(): Promise<number> {
  const notes = await listJobNotes();
  // Check both the current (Jobs/Applications) and legacy (Career/Applications) locations.
  const legacyDir = path.join(vault.root, "Career", "Applications");
  let reverted = 0;
  for (const n of notes) {
    if (n.data.status !== "tailoring") continue;
    const slug = `${appSlugPart(n.data.company || n.data.source || "")}-${appSlugPart(n.data.title || "")}`;
    if (await dirExists(path.join(vault.applicationsDir, slug)) || await dirExists(path.join(legacyDir, slug))) {
      continue; // docs still present somewhere
    }
    const body = n.body.replace(/- \[[xX]\] Interested/, "- [ ] Interested");
    const data = { ...n.data, status: "lead", interested: false, statusChanged: new Date().toISOString() };
    await writeFileRetry(n.file, matter.stringify(body, data));
    await removeOpportunityEntry(String(n.data.id ?? ""));
    reverted++;
  }
  return reverted;
}

/**
 * Auto-expire: move any still-active job whose closing date has passed to "dropped".
 * Only touches lead/interested/tailoring jobs — applied/interview/offer are left alone
 * (you already acted on those). Marks `expired: true` so the board can label it.
 */
export async function expireClosedJobs(): Promise<number> {
  const ACTIVE = new Set(["lead", "interested", "tailoring"]);
  const now = Date.now();
  let expired = 0;
  for (const n of await listJobNotes()) {
    const closes = n.data.closes;
    if (!closes || !ACTIVE.has(String(n.data.status ?? "lead"))) continue;
    const t = new Date(String(closes)).getTime();
    if (Number.isNaN(t) || t >= now) continue; // missing/unparseable or not yet closed
    const body = n.body.replace(/- \[[xX]\] Interested/, "- [ ] Interested");
    const data = {
      ...n.data,
      status: "dropped",
      interested: false,
      expired: true,
      statusChanged: new Date().toISOString(),
    };
    await writeFileRetry(n.file, matter.stringify(body, data));
    expired++;
  }
  return expired;
}

export interface RestoreDroppedResult {
  scanned: number;
  restored: number;
  titles: string[];
}

/**
 * Move Dropped jobs back to Opportunities (`lead`). Recovery tool for a run that dropped
 * leads it shouldn't have — e.g. the Applied-title duplicate bug, which matched brand-new
 * roles at other companies against a generic title you'd already applied to somewhere else.
 *
 * Deliberately narrow, because a Dropped note carries no record of WHO dropped it and a
 * manual "not interested" must not come back:
 *   - only `status: dropped`
 *   - never one flagged `expired` (the listing is gone; restoring it is noise)
 *   - never one with an `applied` date (you acted on it)
 *   - `minFit` / `since` bound it to the band and window you actually want back
 *   - `titlePattern` bounds it to a job family (e.g. developer/engineer)
 */
export async function restoreDropped(opts: {
  minFit?: number;
  since?: string;
  titlePattern?: RegExp;
  dryRun?: boolean;
} = {}): Promise<RestoreDroppedResult> {
  const { minFit = 0, since, titlePattern, dryRun = false } = opts;
  const sinceMs = since ? new Date(since).getTime() : undefined;
  const out: RestoreDroppedResult = { scanned: 0, restored: 0, titles: [] };

  for (const n of await listJobNotes()) {
    const d = n.data;
    if (String(d.status ?? "") !== "dropped") continue;
    out.scanned++;
    if (d.expired === true || d.applied) continue;
    if (typeof d.fit !== "number" || d.fit < minFit) continue;
    if (titlePattern && !titlePattern.test(String(d.title ?? ""))) continue;
    if (sinceMs !== undefined) {
      const t = new Date(String(d.statusChanged ?? d.ingested ?? "")).getTime();
      if (Number.isNaN(t) || t < sinceMs) continue;
    }
    out.restored++;
    out.titles.push(`${d.title ?? "(untitled)"} — ${d.company || d.source || "?"} (fit ${d.fit})`);
    if (dryRun) continue;
    await writeFileRetry(
      n.file,
      matter.stringify(n.body, { ...d, status: "lead", statusChanged: new Date().toISOString() }),
    );
  }
  return out;
}

/**
 * Scan the roles you've already APPLIED to and flag any whose listing has since closed —
 * WITHOUT moving them off the Applied column. Unlike expireClosedJobs (which drops still-active
 * leads), an applied job stays applied; we only set `expired: true` so the board shows a
 * "listing closed" badge next to it. Date-based and offline: uses the closing date recorded on
 * each note (orchestrator.scanAppliedExpiry re-fetches first to refresh those dates). Self-heals:
 * clears a stale flag if a previously-flagged listing's closing date is now in the future.
 * Returns { scanned, flagged, cleared }.
 */
export async function flagExpiredApplied(): Promise<{ scanned: number; flagged: number; cleared: number }> {
  const now = Date.now();
  let scanned = 0, flagged = 0, cleared = 0;
  for (const n of await listJobNotes()) {
    if (String(n.data.status ?? "") !== "applied") continue;
    scanned++;
    const t = n.data.closes ? new Date(String(n.data.closes)).getTime() : NaN;
    const isExpired = !Number.isNaN(t) && t < now;
    const wasExpired = !!n.data.expired;
    if (isExpired && !wasExpired) {
      await updateJobNote(n.file, (d) => {
        d.expired = true;
        d.expiredReason = "closed";
        d.expiredDetected = new Date().toISOString();
      });
      flagged++;
    } else if (!isExpired && wasExpired && !Number.isNaN(t) && n.data.expiredReason !== "gone") {
      // The listing is live again (closing date pushed out) — drop the stale flag. Only
      // clears a date-based flag with a real future date: a source-confirmed "gone" flag
      // (expiredReason: "gone", set by scanAppliedExpiry) is never reset by a lingering date.
      await updateJobNote(n.file, (d) => {
        d.expired = false;
        delete d.expiredReason;
        delete d.expiredDetected;
      });
      cleared++;
    }
  }
  return { scanned, flagged, cleared };
}

/**
 * Refresh an Applied note's closing date and/or set a source-confirmed "listing gone" flag,
 * WITHOUT changing its status. Used by orchestrator.scanAppliedExpiry after a re-fetch:
 * `closesAt` backfills a date the note never had; `confirmedGone` flags a listing the source
 * says is removed (e.g. Seek returns no jobDetails) even when no closing date exists.
 */
export async function updateAppliedListing(
  id: string,
  closesAt?: string,
  confirmedGone = false,
): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  await updateJobNote(note.file, (d) => {
    if (closesAt) d.closes = closesAt;
    if (confirmedGone && !d.expired) {
      d.expired = true;
      d.expiredReason = "gone";
      d.expiredDetected = new Date().toISOString();
    }
  });
  return true;
}

/**
 * Drop a job because it duplicates one already on the board, recording WHY. The same role
 * arrives under a different id from each site (the same "Software Engineer at Acme"
 * is seek-12345678 and zeil-a1b2c3d4), so a duplicate is not a judgement the user made —
 * `dropReason: duplicate` plus `duplicateOf` lets the Dropped card say so, and keeps a
 * manual "not interested" distinguishable from an automatic de-dupe.
 */
export async function dropAsDuplicate(id: string, duplicateOf: string): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  const body = note.body.replace(/- \[[xX]\] Interested/, "- [ ] Interested");
  await writeFileRetry(
    note.file,
    matter.stringify(body, {
      ...note.data,
      status: "dropped",
      interested: false,
      dropReason: "duplicate",
      duplicateOf,
      statusChanged: new Date().toISOString(),
    }),
  );
  return true;
}

/**
 * Mark a single job expired and drop it. Used when a re-fetch confirms the listing
 * is gone (e.g. Seek returns no jobDetails), even though no closing date was recorded.
 */
export async function markJobExpired(id: string): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  await updateJobNote(note.file, (d) => {
    d.status = "dropped";
    d.interested = false;
    d.expired = true;
    d.statusChanged = new Date().toISOString();
  });
  return true;
}

/** Strip a job's block (heading + its bullet lines) from Jobs/Job Opportunities.md by id. */
async function removeOpportunityEntry(id: string): Promise<void> {
  if (!id) return;
  const file = path.join(vault.jobsDir, "Job Opportunities.md");
  const txt = await readSafe(file);
  const marker = `<!-- id:${id} -->`;
  if (!txt.includes(marker)) return;

  const out: string[] = [];
  let skipping = false;
  for (const line of txt.split(/\r?\n/)) {
    if (line.startsWith("## ")) skipping = line.includes(marker); // next heading ends the skip
    if (!skipping) out.push(line);
  }
  await writeFileRetry(file, out.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** Absolute path to a job's application folder (current or legacy location), or "" if none. */
export async function getApplicationDir(id: string): Promise<string> {
  const note = await getJobNoteById(id);
  if (!note) return "";
  const slug = `${appSlugPart(note.data.company || note.data.source || "")}-${appSlugPart(note.data.title || "")}`;
  for (const d of [
    path.join(vault.applicationsDir, slug),
    path.join(vault.root, "Career", "Applications", slug),
  ]) {
    if (await dirExists(d)) return d;
  }
  return "";
}

/** Read the tailored resume + cover letter generated for a job, for the dashboard viewer. */
export async function getApplicationDocs(
  id: string,
): Promise<{ exists: boolean; resume: string; cover: string; folder: string }> {
  const note = await getJobNoteById(id);
  if (!note) return { exists: false, resume: "", cover: "", folder: "" };
  const slug = `${appSlugPart(note.data.company || note.data.source || "")}-${appSlugPart(note.data.title || "")}`;
  const candidates = [
    path.join(vault.applicationsDir, slug),
    path.join(vault.root, "Career", "Applications", slug),
  ];
  let dir = "";
  for (const d of candidates) {
    if (await dirExists(d)) {
      dir = d;
      break;
    }
  }
  if (!dir) return { exists: false, resume: "", cover: "", folder: "" };
  const read = async (f: string) => stripFrontmatter(await readSafe(path.join(dir, f)));
  return {
    exists: true,
    folder: dir,
    resume: await read("resume.md"),
    cover: await read("cover-letter.md"),
  };
}

/** Drop a leading YAML frontmatter block so the viewer shows just the document body. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
}

/**
 * List the regular files in a job's application folder (name + size), newest generation
 * order not guaranteed so sorted by name. Feeds the dashboard's downloadable file list —
 * the OS-independent way to get resume/cover-letter (.md and .docx) off a remote/container
 * server, instead of trying to open a file manager on the server host.
 */
export async function listApplicationFiles(id: string): Promise<{ name: string; size: number }[]> {
  const dir = await getApplicationDir(id);
  if (!dir) return [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; size: number }[] = [];
  for (const n of names.sort()) {
    try {
      const st = await fs.stat(path.join(dir, n));
      if (st.isFile()) out.push({ name: n, size: st.size });
    } catch {
      /* skip unreadable entry */
    }
  }
  return out;
}

/**
 * Resolve a single file inside a job's application folder to an absolute path, or "" if it
 * doesn't exist. Hardened against path traversal: only a bare filename within the folder is
 * accepted (no "..", no absolute paths, no nested segments).
 */
export async function resolveApplicationFile(id: string, name: string): Promise<string> {
  const dir = await getApplicationDir(id);
  if (!dir) return "";
  const safe = path.basename(String(name || "")); // strip any directory segments
  if (!safe || safe === "." || safe === "..") return "";
  const full = path.join(dir, safe);
  const rel = path.relative(dir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return ""; // escaped the folder
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return "";
  } catch {
    return "";
  }
  return full;
}

/** Tick (or untick) the "- [ ] Interested" checkbox in a job note body, visible in Obsidian. */
export async function setInterested(id: string, interested: boolean): Promise<boolean> {
  const note = await getJobNoteById(id);
  if (!note) return false;
  const mark = interested ? "x" : " ";
  let body = note.body;
  if (/- \[[ xX]\] Interested/.test(body)) {
    body = body.replace(/- \[[ xX]\] Interested/, `- [${mark}] Interested`);
  } else {
    // Older note without the checkbox — insert one after the H1.
    body = body.replace(/^(#[^\n]*\n)/, `$1\n- [${mark}] Interested\n`);
  }
  const data = { ...note.data, interested };
  await writeFileRetry(note.file, matter.stringify(body, data));
  return true;
}

/** List report files in Career/Applications/, newest first. */
export async function listReports(): Promise<{ file: string; date: string }[]> {
  let files: string[];
  try {
    files = await fs.readdir(vault.reportsDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^report-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => ({ file: path.join(vault.reportsDir, f), date: f.slice(7, 17) }));
}

/** The most recent report with its markdown, or null. */
export async function latestReport(): Promise<{ file: string; date: string; markdown: string } | null> {
  const [first] = await listReports();
  if (!first) return null;
  return { ...first, markdown: await readSafe(first.file) };
}

// --- Dashboard filter presets (stored in the vault, so they sync) ------------

/** Read the saved dashboard filter presets ({ name: filters }) from the vault. */
export async function readPresets(): Promise<Record<string, unknown>> {
  try {
    const j = JSON.parse(await readSafe(vault.dashboardPresets));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Persist the dashboard filter presets to Career/dashboard-presets.json. */
export async function writePresets(presets: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(vault.dashboardPresets), { recursive: true });
  await writeFileRetry(vault.dashboardPresets, JSON.stringify(presets ?? {}, null, 2));
}

// --- Applied history: the roles you've applied for, kept past the board -------

/**
 * Every role you've applied for, as a permanent ledger in Career/applied-history.json.
 *
 * A search run decides "already applied" by indexing the Applied / Unsuccessful notes.
 * That works only while those notes sit on the board — clear the columns and every one of
 * those roles becomes a fresh lead again on the next run. This file is the part that
 * outlives the notes: `archiveApplied` writes an entry here BEFORE it moves a note, and
 * nothing ever deletes one, so the exclusion holds no matter what the board looks like.
 *
 * Unreadable or hand-mangled JSON yields an empty list rather than throwing — the board
 * must still load — but note that an empty list means no exclusions, so a corrupt file is
 * logged loudly rather than passed over in silence.
 */
export async function readAppliedHistory(): Promise<AppliedHistoryEntry[]> {
  const raw = await readSafe(vault.appliedHistory);
  if (!raw.trim()) return [];
  try {
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) throw new Error("expected a JSON array");
    return j.filter(
      (e): e is AppliedHistoryEntry =>
        !!e && typeof e === "object" && typeof e.title === "string" && !!e.title,
    );
  } catch (e) {
    console.warn(
      `[applied-history] ${path.basename(vault.appliedHistory)} is unreadable — treating it as empty, ` +
        `so previously applied roles may resurface: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

/**
 * Merge entries into the applied-history ledger, keyed by job id — re-archiving a role
 * that's already recorded refreshes it instead of adding a second copy. Returns how many
 * were new and the resulting total.
 */
export async function recordAppliedHistory(
  entries: AppliedHistoryEntry[],
): Promise<{ added: number; total: number }> {
  const existing = await readAppliedHistory();
  const byId = new Map(existing.map((e) => [String(e.id ?? ""), e]));
  let added = 0;
  for (const e of entries) {
    const key = String(e.id ?? "");
    if (!byId.has(key)) added++;
    byId.set(key, e);
  }
  const merged = [...byId.values()];
  await fs.mkdir(path.dirname(vault.appliedHistory), { recursive: true });
  await writeFileRetry(vault.appliedHistory, JSON.stringify(merged, null, 2));
  return { added, total: merged.length };
}

/** One ledger entry describing a note about to leave the board. */
function historyEntry(n: JobNote): AppliedHistoryEntry {
  const d = n.data;
  return {
    id: String(d.id ?? ""),
    title: String(d.title ?? ""),
    company: d.company ? String(d.company) : undefined,
    url: d.url ? String(d.url) : undefined,
    source: d.source ? String(d.source) : undefined,
    status: String(d.status) === "unsuccessful" ? "unsuccessful" : "applied",
    applied: d.applied ? String(d.applied) : undefined,
    archivedAt: new Date().toISOString(),
  };
}

export interface ArchiveAppliedResult {
  scanned: number;
  archived: number;
  /** New ledger entries written (an already-recorded role is refreshed, not re-added). */
  recorded: number;
  historyTotal: number;
  entries: string[];
}

/**
 * Clear the Applied and Unsuccessful columns off the board without losing the fact that
 * you applied.
 *
 * Two halves, in this order, because the order is the safety property:
 *  1. write every note's identity into the applied-history ledger, then
 *  2. move the note file into Career/Jobs/Archive/.
 *
 * A crash between the two leaves a role recorded twice over (ledger + note), which the
 * de-dupe already tolerates; the reverse order would leave a role recorded nowhere and
 * hand it back to the next search as a fresh lead.
 *
 * The notes are MOVED, not deleted — the vault scan reads Career/Jobs non-recursively, so
 * an archived note is off the board while the file, and the generated resume/cover letter
 * in Career/Jobs/Applications/, stay exactly where they were.
 */
export async function archiveApplied(
  opts: { statuses?: JobStatus[]; dryRun?: boolean } = {},
): Promise<ArchiveAppliedResult> {
  const { statuses = ["applied", "unsuccessful"] as JobStatus[], dryRun = false } = opts;
  const want = new Set<string>(statuses);
  const notes = (await listJobNotes()).filter((n) => want.has(String(n.data.status ?? "lead")));
  const out: ArchiveAppliedResult = {
    scanned: notes.length,
    archived: 0,
    recorded: 0,
    historyTotal: 0,
    entries: [],
  };
  if (!notes.length) {
    out.historyTotal = (await readAppliedHistory()).length;
    return out;
  }

  for (const n of notes) {
    out.entries.push(
      `${n.data.title ?? "(untitled)"} — ${n.data.company || n.data.source || "?"}` +
        ` [${n.data.status}${n.data.applied ? `, applied ${n.data.applied}` : ""}]`,
    );
  }

  if (dryRun) {
    out.historyTotal = (await readAppliedHistory()).length;
    return out;
  }

  const rec = await recordAppliedHistory(notes.map(historyEntry));
  out.recorded = rec.added;
  out.historyTotal = rec.total;

  await fs.mkdir(vault.archiveDir, { recursive: true });
  for (const n of notes) {
    const dest = path.join(vault.archiveDir, path.basename(n.file));
    try {
      await fs.rename(n.file, dest);
    } catch {
      // Cross-device (or a share that refuses rename): copy then remove.
      await fs.copyFile(n.file, dest);
      await fs.rm(n.file, { force: true });
    }
    forgetNote(n.file);
    await removeOpportunityEntry(String(n.data.id ?? ""));
    out.archived++;
  }
  console.log(
    `[archive-applied] archived ${out.archived} note(s) to ${vault.archiveDir} · ` +
      `${out.recorded} new history entr(ies) · ${out.historyTotal} role(s) on record`,
  );
  return out;
}
