import { getIngestSource, parseAlert } from "./ingest/index.js";
import { loadProfile, writeJobNote, existingJobIds, setJobScore } from "./vault.js";
import { scoreJob } from "./score.js";
import { writeReport } from "./report.js";
import type { Job, Score, PipelineSummary } from "./types.js";

/** Stage 1: pull alert emails → parse → dedupe → write `lead` job notes. */
export async function ingest(): Promise<Job[]> {
  const source = getIngestSource();
  const alerts = await source.fetch();
  const seen = await existingJobIds();

  const jobs: Job[] = [];
  for (const alert of alerts) {
    for (const job of parseAlert(alert)) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
      await writeJobNote(job, "lead");
    }
  }
  console.log(`[ingest] ${source.name}: ${alerts.length} alerts → ${jobs.length} new jobs`);
  return jobs;
}

/** Stage 2+3: score given jobs vs profile, persist scores to notes, write a ranked report. */
export async function scoreAndReport(
  jobs: Job[],
): Promise<{ file: string; rows: { job: Job; score: Score }[] }> {
  const profile = await loadProfile();
  const rows: { job: Job; score: Score }[] = [];
  for (const job of jobs) {
    const score = await scoreJob(job, profile);
    rows.push({ job, score });
    await setJobScore(job.id, score); // make the score visible on the board
    console.log(`[score] ${score.fit.toString().padStart(3)}  ${job.title}${score.rejected ? "  (rejected)" : ""}`);
  }
  const file = await writeReport(rows);
  console.log(`[report] ${file}`);
  return { file, rows };
}

/** Full read-side pipeline: ingest → score → report. Returns a summary for the scheduler/dashboard. */
export async function runPipeline(): Promise<PipelineSummary> {
  const ranAt = new Date().toISOString();
  const jobs = await ingest();
  if (jobs.length === 0) {
    return { ranAt, ingested: 0, found: 0, enriched: 0, scored: 0, kept: 0, rejected: 0, duplicates: 0, reportFile: null };
  }
  const { file, rows } = await scoreAndReport(jobs);
  const rejected = rows.filter((r) => r.score.rejected).length;
  return {
    ranAt,
    ingested: jobs.length,
    found: jobs.length,
    enriched: 0,
    scored: rows.length,
    kept: rows.length - rejected,
    rejected,
    // The email-ingest pipeline has no board-wide de-dupe pass of its own.
    duplicates: 0,
    reportFile: file,
  };
}

/** CLI wrapper around runPipeline. Stops at GATE 1 (human). */
export async function run(): Promise<void> {
  const s = await runPipeline();
  if (s.ingested === 0) {
    console.log("No new jobs. Drop alert files in ./inbox (file source) or wire Graph/IMAP.");
    return;
  }
  console.log("GATE 1: review the report, set jobs to `status: interested`, then run `tailor`.");
}
