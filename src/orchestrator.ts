import { loadSearchConfig, type SearchConfig, type SiteName } from "./searchConfig.js";
import { resumeAgent } from "./agents/resume.js";
import { searchAll, searchTrack, normTitle, normCompany, isDistinctiveTitle, SOURCE_RANK } from "./agents/search/index.js";
import { enrichDescriptions } from "./agents/search/describe.js";
import { scoreJob, scorerId } from "./score.js";
import { profileDigest, profileFingerprint } from "./profile.js";
import { requireOllama, releaseOllamaIfIdle, OllamaUnavailableError } from "./llm.js";
import { mapLimit } from "./concurrency.js";
import { config } from "./config.js";
import { writeReport } from "./report.js";
import { loadProfile, writeJobNote, setJobScore, setJobStatus, listJobNotes, markJobExpired, getJobNoteById, flagExpiredApplied, updateAppliedListing, invalidateJobNoteCache, dropAsDuplicate, readAppliedHistory, type JobNote } from "./vault.js";
import { syncContactsFromJobs } from "./contacts.js";
import { vlog } from "./logbus.js";
import { startRun, updateRun, finishRun, failRun } from "./runProgress.js";
import { JobSchema, type AppliedHistoryEntry, type Job, type JobStatus, type Score } from "./types.js";

/** Elapsed seconds since t0, formatted for log lines. */
const since = (t0: number): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Active opportunity stages an expired/applied dup can be auto-dropped from. */
const ACTIVE_OPP: Set<string> = new Set(["lead", "interested", "tailoring"]);

/**
 * Note writes in flight during a run. The vault is normally an SMB share where a write
 * is a network round-trip, so this is latency, not CPU — the same reason note reads run
 * at 64 (see vault.ts). Kept lower than the read limit because a write also takes a lock
 * and has a retry path.
 */
const VAULT_WRITE_CONCURRENCY = 8;

/**
 * Jobs scored at once. The model call dominates, so the point is to keep the vault write
 * and JSON parse of one job overlapped with the next job's inference rather than to run
 * inference in parallel: a local Ollama server serialises requests anyway unless
 * OLLAMA_NUM_PARALLEL says otherwise, and pushing a 32B model to answer several prompts
 * at once just thrashes VRAM. The hosted API has no such limit, so it gets a wider lane.
 * Override with SCORE_CONCURRENCY.
 */
function scoreConcurrency(): number {
  const n = Number(process.env.SCORE_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return config.anthropicApiKey ? 6 : 2;
}

/**
 * True when a job title contains any of a track's `title_match` terms as whole words.
 *
 * Whole-word, not substring: a bare "it" term has to hit "Operations & IT Support" and
 * not "Unit Manager" or "Recruitment". Punctuation is flattened to spaces first so
 * "IT/Systems Support" and "Help-Desk" match the same terms as their spaced spellings.
 */
export function titleMatches(title: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const flat = ` ${normTitle(title)} `;
  return terms.some((t) => {
    const term = normTitle(t);
    return !!term && flat.includes(` ${term} `);
  });
}

/** True when an ISO closing date sits in the past (listing has closed). */
function isPastClose(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

/**
 * Optional overrides that let a saved dashboard filter steer the search, instead of
 * only the vault's job-search.md. Empty/omitted fields fall back to the file config.
 *   - sites: restrict which job boards run (e.g. just ["seek"])
 *   - employmentType / engagement: server-side filters applied during the run
 *   - keywords: replaces the resume-derived query (same effect as keywords_override)
 */
export interface SearchOverrides {
  sites?: SiteName[];
  employmentType?: SearchConfig["employmentType"];
  engagement?: SearchConfig["engagement"];
  keywords?: string;
}

/** Merge filter overrides onto the file-based search config (overrides win). */
function applyOverrides(cfg: SearchConfig, o: SearchOverrides): SearchConfig {
  const next = { ...cfg };
  if (o.sites && o.sites.length) next.sites = o.sites;
  if (o.employmentType) next.employmentType = o.employmentType;
  if (o.engagement) next.engagement = o.engagement;
  if (o.keywords && o.keywords.trim()) next.keywordsOverride = o.keywords.trim();
  return next;
}

export interface AgenticSummary {
  ranAt: string;
  /** All target-role queries this run searched for, joined for display. */
  query: string;
  bySite: Record<string, { count: number; error?: string }>;
  found: number;
  enriched: number; // jobs whose full description was fetched from the listing url
  scored: number;
  kept: number;
  rejected: number;
  /** Listings this run refused because the board already holds a decision on the role. */
  skippedDecided: number;
  skippedDropped: number;
  /** Notes the closing de-dupe sweep moved to Dropped as duplicates. */
  duplicatesDropped: number;
  reportFile: string | null;
}

/**
 * Search run: resume agent → search agents → full-description enrichment → score.
 * Lands every job in the "Opportunities" column. It does NOT generate any
 * application docs and never submits anything — tailoring only happens when the
 * user marks a job Interested (see workflow.markInterested).
 *
 * Wrapper around the pipeline that publishes live progress (see runProgress.ts) so the
 * dashboard can show what the run is doing instead of a silent multi-minute button.
 */
export async function runAgents(overrides: SearchOverrides = {}): Promise<AgenticSummary> {
  // Preflight before anything runs. Scoring is the whole point of a run — a run that
  // searches four boards and then keyword-scores everything produces a board of numbers no
  // model ever saw, which is worse than not running. Checked up front so nothing is written
  // and nothing has to be undone. Only when Ollama is the scorer: with an Anthropic key set,
  // scoring goes to Claude and the local model is irrelevant to this run.
  if (!config.anthropicApiKey) await requireOllama("The search run's job scoring");
  startRun();
  try {
    const summary = await runPipeline(overrides);
    finishRun({
      found: summary.found,
      kept: summary.kept,
      duplicates: summary.skippedDecided + summary.skippedDropped + summary.duplicatesDropped,
    });
    return summary;
  } catch (e) {
    failRun(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    // Ollama holds the model resident for keep_alive (5 min) after the last call, so a
    // finished run left ~15GB sitting in memory while the Activity screen said "done".
    if (!config.anthropicApiKey) await releaseOllamaIfIdle();
  }
}

async function runPipeline(overrides: SearchOverrides = {}): Promise<AgenticSummary> {
  const ranAt = new Date().toISOString();
  const tRun = Date.now();
  // The vault note cache serves the dashboard stale-while-revalidate; a run decides what to
  // keep and what to drop, so start it from a guaranteed-fresh read of the vault.
  invalidateJobNoteCache();
  const cfg = applyOverrides(await loadSearchConfig(), overrides);
  const profile = await loadProfile();
  const ov = Object.entries(overrides).filter(([, v]) => v != null && (!Array.isArray(v) || v.length));
  if (ov.length) console.log(`[run] filter overrides: ${ov.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join(" ")}`);
  console.log(
    `[run] starting — sites=[${cfg.sites.join(", ")}] employmentType=${cfg.employmentType} engagement=${cfg.engagement}` +
      cfg.tracks.map((t) => ` +${t.name}=[${t.searches.join(", ")}${t.locations[0] ? ` @ ${t.locations[0]}` : ""}]`).join(""),
  );

  // 1. Resume agent — derive the target-role queries + keywords.
  const tResume = Date.now();
  const ctx = await resumeAgent(cfg);
  console.log(`[resume] queries=${ctx.searchQueries.map((q) => `"${q}"`).join(", ")}`);
  console.log(`[resume] keywords=${ctx.keywords.slice(0, 6).join(", ")}`);
  vlog(`[resume] derived in ${since(tResume)}`);

  // 2. Search agents — one search per target role, then gather + dedupe across enabled sites.
  const tSearch = Date.now();
  updateRun({
    phase: "searching",
    message: `Retrieving opportunities from ${cfg.sites.join(", ")}…`,
  });
  const { jobs, bySite } = await searchAll(ctx.searchQueries, cfg);
  vlog(`[search] gather + dedupe in ${since(tSearch)}`);
  for (const [site, r] of Object.entries(bySite)) {
    console.log(`[search] ${site}: ${r.error ? `ERROR ${r.error}` : `${r.count} jobs`}`);
  }
  console.log(`[search] ${jobs.length} unique jobs after dedupe`);
  updateRun({ found: jobs.length, bySite: { ...bySite } });

  // 3. Full descriptions — second HTTP call to each listing url.
  const tDescribe = Date.now();
  updateRun({
    phase: "describing",
    message: `Found ${jobs.length} opportunities — fetching full descriptions…`,
  });
  let { enriched } = await enrichDescriptions(jobs);
  console.log(`[describe] fetched full text for ${enriched}/${jobs.length} listings`);
  vlog(`[describe] enriched in ${since(tDescribe)}`);

  // 3a. Expired listings — never pull a role whose listing has already closed. If we
  //     already hold an active note for it (lead/interested/tailoring), drop it.
  const liveJobs: Job[] = [];
  let expiredDropped = 0;
  for (const j of jobs) {
    if (j.expired || isPastClose(j.closesAt)) {
      const note = await getJobNoteById(j.id);
      if (note && ACTIVE_OPP.has(String(note.data.status ?? "lead"))) {
        await markJobExpired(j.id);
        expiredDropped++;
      }
      continue;
    }
    liveJobs.push(j);
  }
  if (liveJobs.length !== jobs.length) {
    console.log(
      `[expire] skipped ${jobs.length - liveJobs.length} expired listing(s) this run${expiredDropped ? ` (${expiredDropped} already on the board → Dropped)` : ""}`,
    );
  }

  // 3b. Employment-type filter — drives results to the type set in job-search.md
  //     (keeps unknowns so a missing label never hides an otherwise-good job).
  updateRun({ phase: "filtering", message: `Checking ${liveJobs.length} opportunities against the board…` });
  const wanted = cfg.employmentType;
  let kept_jobs =
    wanted === "any"
      ? liveJobs
      : liveJobs.filter((j) => j.employmentType === wanted || j.employmentType === "unknown");
  if (wanted !== "any") {
    console.log(`[filter] employment_type=${wanted}: ${kept_jobs.length}/${liveJobs.length} kept`);
  }

  // 3c. Engagement filter — permanent vs contract/temp (keeps unknowns so a missing
  //     label never hides an otherwise-good job). Set via `engagement` in job-search.md.
  const wantEng = cfg.engagement;
  if (wantEng !== "any") {
    const before = kept_jobs.length;
    kept_jobs = kept_jobs.filter((j) => j.engagement === wantEng || j.engagement === "unknown");
    console.log(`[filter] engagement=${wantEng}: ${kept_jobs.length}/${before} kept`);
  }

  // 3d. Extra tracks — separate job categories (courier / driver; any IT role close to
  //     home). These deliberately bypass the employment-type/engagement filters above,
  //     which are tuned for the primary career track, so casual/part-time/contract roles
  //     still surface in Opportunities. Each track searches its own area and is deduped
  //     against the primary results, and against the tracks already run, by id.
  let extraFound = 0;
  // Extra-track ids, so the min-fit cut below can exempt them: a courier run or a local
  // helpdesk role is scored against a senior-developer profile and is SUPPOSED to rank
  // low — they're on the board for visibility, not fit.
  const extraIds = new Set<string>();
  // Which track each job came from, so the note can say so and the board can lead with
  // the local ones. A job found by two tracks keeps the first that claimed it.
  const trackOf = new Map<string, string>();
  for (const track of cfg.tracks) {
    const extra = await searchTrack(track, cfg);
    let extraJobs = extra.jobs;
    for (const [site, r] of Object.entries(extra.bySite)) {
      bySite[site] = { count: (bySite[site]?.count ?? 0) + r.count, error: bySite[site]?.error ?? r.error };
    }
    if (track.seekClassifications.length || track.tradeMeCategories.length) {
      console.log(
        `[${track.name}] category browse: ${extra.categoryIds.size} listing(s) the boards themselves file under` +
          ` ${[...track.seekClassifications, ...track.tradeMeCategories].join(", ")}`,
      );
    }

    // Location filter. The search itself is already scoped to the track's first location
    // term; this keeps only the results that actually name one of its places, which is
    // what catches TradeMe (its API takes no location) and any board that widened the area.
    if (track.locations.length) {
      const before = extraJobs.length;
      const terms = track.locations.map((t) => t.toLowerCase());
      extraJobs = extraJobs.filter((j) => {
        const loc = (j.location ?? "").toLowerCase();
        return terms.some((t) => loc.includes(t));
      });
      console.log(`[${track.name}] location filter (${track.locations.join(", ")}): ${extraJobs.length}/${before} kept`);
    }

    // Title filter. A keyword query is matched against the whole ad body, so a broad
    // track ("information technology") also returns every local ad that merely mentions
    // computers. Tracks are exempt from min_fit_to_keep by design, so this is the filter
    // that keeps such a track on-topic.
    // A listing the board itself filed under the track's category is kept regardless: the
    // filter is there to clean up keyword results, and applying it to a category browse
    // discards real ones whose titles carry none of its words (Seek files "Product
    // Manager - Lending" and "Senior Project Manager" under ICT).
    if (track.titleMatch.length) {
      const before = extraJobs.length;
      extraJobs = extraJobs.filter(
        (j) => extra.categoryIds.has(j.id) || titleMatches(j.title, track.titleMatch),
      );
      console.log(`[${track.name}] title filter: ${extraJobs.length}/${before} kept`);
    }

    const e = await enrichDescriptions(extraJobs);
    enriched += e.enriched;
    const have = new Set(kept_jobs.map((j) => j.id));
    const newExtra = extraJobs.filter((j) => !have.has(j.id) && !j.expired && !isPastClose(j.closesAt));
    extraFound += newExtra.length;
    // Exempt every job the track vouched for, not only the ones it contributed. A local
    // IT role the primary track happened to find first was reaching the off-target cut
    // unexempted and being dropped on its fit — exactly the roles this track exists to
    // keep, since being scored low against a senior-developer CV is expected of them.
    for (const j of extraJobs) {
      extraIds.add(j.id);
      if (!trackOf.has(j.id)) trackOf.set(j.id, track.name);
    }
    kept_jobs = [...kept_jobs, ...newExtra];
    const how = track.searches.length
      ? track.searches.join(" / ")
      : `category browse (${[...track.seekClassifications, ...track.tradeMeCategories].join(", ")})`;
    console.log(`[${track.name}] ${how}: ${newExtra.length} job(s) added (bypass type/engagement filters)`);
  }

  // 3g. Don't pull anything the board has already decided on — Applied, or Applied and
  //     since marked Unsuccessful. You don't want to be shown a role you already sent an
  //     application for, whatever the outcome was. Drop this run's matches before they're
  //     written, and drop any existing Opportunities note that duplicates one of them.
  //     The index spans the notes AND the applied-history ledger, so roles whose notes
  //     were cleared off the board (`archive-applied`) stay excluded just the same.
  const allNotes = await listJobNotes();
  const decidedIdx = await loadDecidedIndex(allNotes);
  let skippedDecided = 0;
  if (decidedIdx.size) {
    const before = kept_jobs.length;
    kept_jobs = kept_jobs.filter((j) => !matchesRole(j, decidedIdx));
    skippedDecided = before - kept_jobs.length;
    if (skippedDecided) console.log(`[applied] skipped ${skippedDecided} role(s) you've already applied to`);
    const droppedDup = await dropOpportunitiesAlreadyApplied(allNotes, decidedIdx);
    if (droppedDup) console.log(`[applied] dropped ${droppedDup} existing Opportunities already applied to`);
  }

  // 3h. Don't resurrect anything already in Dropped. A role you dropped from one board
  //     comes back under a different id when another board lists it — the same
  //     "Software Engineer at Acme" is seek-12345678 and zeil-a1b2c3d4 — and a new
  //     id means a new note, so it reappears as a fresh lead. Match on role, not id.
  //     Existing notes are left alone: this only stops NEW arrivals, so a job already on
  //     the board (possibly triaged since) is never moved out from under the user.
  const droppedIdx = buildDroppedIndex(allNotes);
  let skippedDropped = 0;
  if (droppedIdx.size) {
    const before = kept_jobs.length;
    kept_jobs = kept_jobs.filter((j) => !matchesRole(j, droppedIdx));
    skippedDropped = before - kept_jobs.length;
    if (skippedDropped) {
      console.log(`[dropped] skipped ${skippedDropped} role(s) you already dropped`);
    }
  }

  // 4. Score every job, persist an Opportunities note for each. A note that already
  //     carries a score keeps it — scoring is the slow step (a local Ollama call per
  //     job), and re-running it on a listing whose text hasn't changed just burns
  //     minutes to land on the same number. Re-score deliberately with `npm run rescore`.
  const tScore = Date.now();
  const scoredBefore = new Map(
    allNotes.map((n) => [String(n.data.id), typeof n.data.fit === "number"]),
  );
  const toScore = kept_jobs.filter((j) => !scoredBefore.get(j.id));
  console.log(
    `[score] scoring ${toScore.length} new job(s)` +
      (kept_jobs.length - toScore.length
        ? ` (${kept_jobs.length - toScore.length} already scored — skipped)`
        : ""),
  );
  updateRun({
    phase: "scoring",
    newJobs: toScore.length,
    toScore: toScore.length,
    scored: 0,
    duplicates: skippedDecided + skippedDropped,
    message: toScore.length
      ? `Found ${jobs.length + extraFound} opportunities — scoring ${toScore.length} new one(s)…`
      : `Found ${jobs.length + extraFound} opportunities — nothing new to score`,
  });
  // Per-job isolation. Every job here means a vault write, and the vault is usually an
  // SMB share — one note being momentarily locked used to throw straight out of the run,
  // abandoning every job after it plus the report and contacts sync. A run that dies at
  // job 23 of 198 delivers almost nothing and looks like "no leads came through".
  const failures: string[] = [];
  let lowFit = 0;
  let scoredCount = 0;
  // Indexed by kept_jobs position so a concurrent pass still reports in board order.
  const rowSlots = new Array<{ job: Job; score: Score } | undefined>(kept_jobs.length);
  const failedIdx = new Set<number>();
  const fail = (job: Job, i: number, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    failedIdx.add(i);
    failures.push(`${job.title}: ${msg}`);
    console.warn(`[score] SKIPPED "${job.title}" — ${msg}`);
  };

  // 4a. Persist a note for every job. One write is a single SMB round-trip, so ~200 of
  //     them in series is minutes of pure latency for work that has no ordering
  //     requirement — each job writes its own file.
  const tWrite = Date.now();
  await mapLimit(kept_jobs, VAULT_WRITE_CONCURRENCY, async (job, i) => {
    try {
      // `track` on the note is what lets the board lead with the local roles: they are
      // meant to score low against a senior-developer CV, so fit alone buries them.
      await writeJobNote(job, "lead", trackOf.has(job.id) ? { track: trackOf.get(job.id) } : {});
      // Already carries a fit: reuse it for the report rather than paying for a rescore.
      if (scoredBefore.get(job.id)) {
        const prior = await getJobNoteById(job.id);
        if (prior) rowSlots[i] = { job, score: scoreFromNote(job.id, prior.data) };
      }
    } catch (e) {
      fail(job, i, e);
    }
  });
  vlog(`[score] wrote ${kept_jobs.length} note(s) in ${since(tWrite)}`);

  // 4b. Score the new ones. The model call dominates (a local Ollama pass is tens of
  //     seconds), and running a couple at once keeps the vault write + JSON parse of one
  //     job overlapped with the next job's inference. See SCORE_CONCURRENCY.
  const pending = kept_jobs
    .map((job, i) => ({ job, i }))
    .filter(({ i }) => !rowSlots[i] && !failedIdx.has(i));
  await mapLimit(pending, scoreConcurrency(), async ({ job, i }) => {
    const tJob = Date.now();
    try {
      const score = await scoreJob(job, profile);
      await setJobScore(job.id, score);
      rowSlots[i] = { job, score };
      scoredCount++;
      updateRun({
        scored: scoredCount,
        message: `Found ${jobs.length + extraFound} opportunities — scoring ${scoredCount} of ${toScore.length}…`,
      });
      console.log(`[score] ${String(score.fit).padStart(3)}  ${job.title}${score.rejected ? "  (rejected)" : ""}`);
      vlog(`[score]      matched=[${(score.matchedSkills ?? []).slice(0, 5).join(", ") || "none"}] in ${since(tJob)}`);

      // Off-target cut. Only fires on a brand-new primary-track lead: the extra track is
      // exempt (it is meant to rank low), and a note that already existed is left alone
      // so nothing the user has looked at moves out from under them.
      if (
        cfg.minFitToKeep > 0 &&
        score.fit < cfg.minFitToKeep &&
        !score.rejected &&
        !extraIds.has(job.id) &&
        !scoredBefore.has(job.id)
      ) {
        await setJobStatus(job.id, "dropped");
        lowFit++;
        console.log(`[filter] dropped "${job.title}" — fit ${score.fit} below min_fit_to_keep ${cfg.minFitToKeep}`);
      }
    } catch (e) {
      // A dead Ollama is not a per-job failure: every remaining job would fail the same
      // way, and skipping them all silently would look like a run that merely found
      // nothing. Let it out of the pool so the run stops and reports why.
      if (e instanceof OllamaUnavailableError) throw e;
      fail(job, i, e);
    }
  });
  const rows = rowSlots.filter((r): r is { job: Job; score: Score } => !!r);
  vlog(`[score] scored ${scoredCount} job(s) in ${since(tScore)}`);
  if (failures.length) {
    console.warn(`[score] ${failures.length} job(s) skipped after retries — re-run to pick them up`);
  }
  if (lowFit) {
    console.log(`[filter] ${lowFit} off-target lead(s) dropped below fit ${cfg.minFitToKeep} — see the Dropped column`);
  }

  // 4a. Closing de-dupe sweep. Everything above only vets INCOMING listings, and it can
  //     only match on title/company/url — so two records of one role can still both land:
  //     a note written by an earlier run under a different id, or a listing whose title
  //     the boards word differently. Sweeping the written board is the check that
  //     actually holds, because by now every copy is a note and can be compared as one.
  //     Nothing the user decided is touched: it only moves ACTIVE Opportunities, always
  //     with dropReason "duplicate" and a pointer to the copy that survived.
  updateRun({ phase: "finishing", message: "Checking the board for duplicates…" });
  const sweep = await dedupeOpportunities();
  const sweptIds = new Set(sweep.droppedIds);

  const kept = rows.filter((r) => !r.score.rejected && !sweptIds.has(r.job.id));
  const rejected = rows.filter((r) => r.score.rejected).length;

  // 5. Ranked report — de-duped rows only, so the report never lists one role twice.
  const reportRows = rows.filter((r) => !sweptIds.has(r.job.id));
  const reportFile = reportRows.length ? await writeReport(reportRows) : null;

  // 6. Harvest recruiter/hiring contacts from the ad text into Career/Contacts/.
  try {
    const c = await syncContactsFromJobs();
    console.log(`[contacts] wrote ${c.written} new contact(s) (found ${c.found}, ${c.skipped} already on file)`);
  } catch (e) {
    console.warn(`[contacts] extraction skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  const alreadyHeld = skippedDecided + skippedDropped + sweep.dropped;
  console.log(
    `\n[done] found ${jobs.length + extraFound} · kept ${kept.length} · rejected ${rejected}` +
      (alreadyHeld ? ` · ${alreadyHeld} already on the board` : "") +
      (failures.length ? ` · skipped ${failures.length}` : "") +
      ` · in ${since(tRun)}`,
  );
  console.log(`[next] Open the dashboard, pick the ones you want, click Interested to tailor docs.`);

  return {
    ranAt,
    query: ctx.searchQueries.join(" · "),
    bySite,
    found: jobs.length + extraFound,
    enriched,
    scored: rows.length,
    kept: kept.length,
    rejected,
    skippedDecided,
    skippedDropped,
    duplicatesDropped: sweep.dropped,
    reportFile,
  };
}

/**
 * Re-score existing job notes with the current scorer. Useful after the ranking logic
 * changes so old notes (e.g. left from earlier searches) stop showing stale fit values
 * on the board.
 *
 * `staleOnly` limits the pass to notes whose recorded profile hash / scorer differs from
 * the current one — i.e. the ones scored against an older resume or a different model.
 * That is the usual case after editing the CV, and it skips the notes that would score
 * the same anyway, which matters when each one is a ~55s local model call.
 *
 * Dropped notes are skipped unless `includeDropped` is set. A board accumulates far more
 * dropped roles than live ones (hundreds against dozens), and re-scoring a role you have
 * already said no to changes nothing you look at while dominating the runtime.
 */
export async function rescoreAll(
  { staleOnly = false, includeDropped = false }: { staleOnly?: boolean; includeDropped?: boolean } = {},
): Promise<{ rescored: number; skipped: number }> {
  const profile = await loadProfile();
  const notes = await listJobNotes();
  const currentHash = profileFingerprint(profileDigest(profile));
  const currentScorer = scorerId();
  let rescored = 0;
  let skipped = 0;
  console.log(
    `[rescore] current profile ${currentHash} · scorer ${currentScorer}` +
      (staleOnly ? " · stale notes only" : "") +
      (includeDropped ? "" : " · skipping Dropped"),
  );
  for (const n of notes) {
    const d = n.data;
    if (!includeDropped && String(d.status ?? "lead") === "dropped") {
      skipped++;
      continue;
    }
    if (staleOnly && d.profileHash === currentHash && d.scorer === currentScorer) {
      skipped++;
      continue;
    }
    const i = n.body.indexOf("## Description");
    const description = (i >= 0 ? n.body.slice(i + "## Description".length) : n.body).trim();
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
      description,
      ingestedAt: d.ingested ?? new Date().toISOString(),
    });
    if (!parsed.success) continue;
    const score = await scoreJob(parsed.data, profile);
    await setJobScore(String(d.id), score);
    rescored++;
    console.log(`[rescore] ${String(score.fit).padStart(3)}  ${parsed.data.title}`);
  }
  console.log(
    `[rescore] done — ${rescored} notes re-scored` +
      (skipped ? ` · ${skipped} skipped (dropped or already current)` : ""),
  );
  return { rescored, skipped };
}

/**
 * Re-fetch full descriptions for existing job notes (default: the Opportunities
 * column) and rewrite any whose listing now yields more text. Useful to backfill
 * jobs that came in thin because enrichment failed the first time. Re-scores the
 * ones that gained a fuller description, since fit depends on the text.
 */
export async function reenrichDescriptions(
  statuses: JobStatus[] = ["lead"],
): Promise<{ scanned: number; enriched: number; expired: number }> {
  const profile = await loadProfile();
  const notes = await listJobNotes();
  const want = new Set(statuses);
  const targets = notes.filter((n) => want.has((n.data.status ?? "lead") as JobStatus));
  console.log(`[reenrich] scanning ${targets.length} job(s) in [${statuses.join(", ")}]…`);

  // Reconstruct Job objects (carry current description so enrichment only
  // overwrites when it finds something longer).
  const jobs: Job[] = [];
  const byId = new Map<string, (typeof notes)[number]>();
  for (const n of targets) {
    const d = n.data;
    const i = n.body.indexOf("## Description");
    let description = (i >= 0 ? n.body.slice(i + "## Description".length) : "").trim();
    if (description === "_(not captured)_") description = "";
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
      description,
      postedAt: d.posted || undefined,
      closesAt: d.closes || undefined,
      ingestedAt: d.ingested ?? new Date().toISOString(),
    });
    if (!parsed.success) continue;
    jobs.push(parsed.data);
    byId.set(parsed.data.id, n);
  }

  const before = new Map(jobs.map((j) => [j.id, j.description.length]));
  const { enriched } = await enrichDescriptions(jobs);

  // Persist the jobs that gained text (re-score those), backfill newly-captured
  // posted/closing dates even when the text didn't grow, and drop any the re-fetch
  // confirmed are gone/expired.
  let expired = 0;
  let dated = 0;
  for (const job of jobs) {
    const n = byId.get(job.id);
    if (job.expired) {
      await markJobExpired(job.id);
      expired++;
      console.log(`[reenrich] expired "${job.title}" — listing no longer available, dropped`);
      continue;
    }
    const grew = (job.description.length ?? 0) > (before.get(job.id) ?? 0);
    const newDates = (!!job.closesAt && !n?.data.closes) || (!!job.postedAt && !n?.data.posted);
    if (!grew && !newDates) continue;
    const status = (n?.data.status ?? "lead") as JobStatus;
    await writeJobNote(job, status); // also backfills posted/closes/salary on the note
    if (grew) {
      const score = await scoreJob(job, profile);
      await setJobScore(job.id, score);
      console.log(`[reenrich] updated "${job.title}" → ${job.description.length} chars, fit ${score.fit}`);
    } else {
      dated++;
      console.log(`[reenrich] dated "${job.title}" — captured posted/closing date`);
    }
  }
  console.log(`[reenrich] done — ${enriched} fuller, ${dated} date-only, ${expired} expired of ${jobs.length}`);
  return { scanned: jobs.length, enriched, expired };
}

/**
 * Scan the roles you've already APPLIED to and flag any whose listing has closed — the
 * application stays in Applied, it just gets an "expired" badge so you know the ad is gone
 * (useful before you chase a follow-up). Re-fetches each listing to refresh its closing date
 * and catch ones a source (Seek) confirms are removed, persists those onto the notes, then
 * sets/clears the flag from the refreshed dates via flagExpiredApplied. Never drops a job.
 */
export async function scanAppliedExpiry(): Promise<{
  scanned: number;
  flagged: number;
  cleared: number;
  confirmedGone: number;
}> {
  const notes = await listJobNotes();
  const applied = notes.filter((n) => String(n.data.status ?? "") === "applied");
  console.log(`[applied-expiry] scanning ${applied.length} applied position(s)…`);

  // Rebuild typed Jobs (carrying the recorded closing date) so we can re-fetch each listing.
  const jobs: Job[] = [];
  for (const n of applied) {
    const d = n.data;
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
      description: "",
      postedAt: d.posted || undefined,
      closesAt: d.closes || undefined,
      ingestedAt: d.ingested ?? new Date().toISOString(),
    });
    if (parsed.success) jobs.push(parsed.data);
  }

  // Re-fetch: refreshes closesAt (Seek) and sets job.expired when a source confirms the
  // listing is gone. Best-effort — a failed fetch leaves that job's recorded date unchanged.
  try {
    await enrichDescriptions(jobs);
  } catch (e) {
    vlog(`[applied-expiry] re-fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Persist refreshed closing dates + source-confirmed "gone" onto the notes (status kept).
  let confirmedGone = 0;
  for (const job of jobs) {
    if (job.expired) {
      await updateAppliedListing(job.id, job.closesAt, true);
      confirmedGone++;
    } else if (job.closesAt) {
      await updateAppliedListing(job.id, job.closesAt);
    }
  }

  // Flag (or self-heal) from the now-refreshed closing dates.
  const r = await flagExpiredApplied();
  console.log(
    `[applied-expiry] done — ${r.flagged} newly flagged, ${confirmedGone} source-confirmed gone, ${r.cleared} cleared, of ${r.scanned}`,
  );
  return { scanned: r.scanned, flagged: r.flagged, cleared: r.cleared, confirmedGone };
}

/** Rebuild the Score already persisted on a note, for the ranked report. */
function scoreFromNote(id: string, d: Record<string, unknown>): Score {
  return {
    jobId: id,
    fit: typeof d.fit === "number" ? d.fit : 0,
    rejected: !!d.autoRejected,
    rejectReasons: Array.isArray(d.rejectReasons) ? (d.rejectReasons as string[]) : [],
    matchedSkills: Array.isArray(d.matched) ? (d.matched as string[]) : [],
    missingSkills: Array.isArray(d.missing) ? (d.missing as string[]) : [],
    rationale: typeof d.rationale === "string" ? d.rationale : "",
    profileHash: typeof d.profileHash === "string" ? d.profileHash : undefined,
    scorer: typeof d.scorer === "string" ? d.scorer : undefined,
  };
}

// normTitle / normCompany / isDistinctiveTitle come from agents/search/index.ts so the
// Applied-duplicate check below and the cross-site dedupe draw the "is this the same
// role?" line in exactly the same place.

/** Normalized index of the roles already sitting in some column of the board. */
export interface RoleIndex {
  soft: Map<string, JobNote>; // normalized "title|company"
  title: Map<string, JobNote>; // normalized title alone (for listings with no company)
  url: Map<string, JobNote>; // exact posting url — two notes on one url are the same ad
  size: number;
}

/** Index every note whose status is in `statuses`, by url, title+company, and title alone. */
export function buildStatusIndex(notes: JobNote[], ...statuses: JobStatus[]): RoleIndex {
  const idx: RoleIndex = { soft: new Map(), title: new Map(), url: new Map(), size: 0 };
  const want = new Set<string>(statuses);
  for (const n of notes) {
    if (!want.has(String(n.data.status ?? "lead"))) continue;
    addToIndex(idx, n);
  }
  return idx;
}

/** Add one note to a role index. First note to claim a key keeps it. */
function addToIndex(idx: RoleIndex, n: JobNote): void {
  const t = normTitle(String(n.data.title ?? ""));
  const co = normCompany(String(n.data.company ?? ""));
  const u = String(n.data.url ?? "").trim();
  if (co && !idx.soft.has(`${t}|${co}`)) idx.soft.set(`${t}|${co}`, n);
  if (isDistinctiveTitle(t) && !idx.title.has(t)) idx.title.set(t, n);
  if (u && !idx.url.has(u)) idx.url.set(u, n);
  idx.size++;
}

/**
 * A ledger entry, shaped as the note it used to be so one index can hold both. `file`
 * carries the id rather than a path: it only ever has to be unequal to a real note's
 * path, which is how `findDuplicate` tells "this note" from "a note it matches".
 */
const historyAsNote = (e: AppliedHistoryEntry): JobNote => ({
  file: `applied-history:${e.id}`,
  data: { id: e.id, title: e.title, company: e.company, url: e.url, source: e.source, status: e.status },
  body: "",
});

/**
 * Roles the board has already decided on: applied for, whatever came back. "Unsuccessful"
 * is included deliberately — an application you sent and lost is still one you sent, and
 * re-surfacing that listing as a fresh lead is the same wasted triage as re-surfacing an
 * open one. Matches the index `dedupeOpportunities` sweeps against, so a run and a manual
 * refresh can never disagree about what counts as already-handled.
 *
 * `history` is the applied-history ledger (Career/applied-history.json), which holds the
 * roles whose notes have been cleared off the board by `archiveApplied`. Without it, the
 * exclusion would last exactly as long as the Applied column did.
 */
export const buildDecidedIndex = (
  notes: JobNote[],
  history: AppliedHistoryEntry[] = [],
): RoleIndex => {
  const idx = buildStatusIndex(notes, "applied", "unsuccessful");
  for (const e of history) addToIndex(idx, historyAsNote(e));
  return idx;
};

/** The decided index including the archived roles — what any caller wanting the full
 *  "already applied" picture should use. */
export async function loadDecidedIndex(notes: JobNote[]): Promise<RoleIndex> {
  return buildDecidedIndex(notes, await readAppliedHistory());
}

/**
 * Index of the roles you're done with — Dropped, EXCEPT the ones a de-dupe pass dropped.
 * A note dropped as a duplicate is not evidence about the role: it is the discarded copy
 * of a role still live on the board. Counting it would make de-duping eat its own
 * survivor on the next pass (drop copy B, then drop copy A as "already dropped", …), and
 * would block a genuine re-listing from ever arriving again.
 */
export function buildDroppedIndex(notes: JobNote[]): RoleIndex {
  return buildStatusIndex(
    notes.filter((n) => n.data.dropReason !== "duplicate"),
    "dropped",
  );
}

/** The indexed note this one duplicates, or undefined. Same posting url is conclusive;
 *  otherwise company+title, or title-only when the listing carries no company AND the
 *  title is distinctive enough to trust without a company to corroborate it. */
function findDuplicate(note: JobNote, idx: RoleIndex): JobNote | undefined {
  const u = String(note.data.url ?? "").trim();
  if (u) {
    const byUrl = idx.url.get(u);
    if (byUrl && byUrl.file !== note.file) return byUrl;
  }
  const t = normTitle(String(note.data.title ?? ""));
  const co = normCompany(String(note.data.company ?? ""));
  const hit = co ? idx.soft.get(`${t}|${co}`) : isDistinctiveTitle(t) ? idx.title.get(t) : undefined;
  return hit && hit.file !== note.file ? hit : undefined;
}

/**
 * True when an incoming listing matches a role already in the index.
 *
 * The posting url is checked first and is conclusive: the same ad re-crawled under a new
 * id (Seek re-issues them, and a re-listing keeps its url) used to slip past a
 * title+company comparison whenever either field came back worded differently, which is
 * exactly how a job you'd already applied to or dropped reappeared as a fresh lead.
 * Otherwise fall back to company+title, or title alone when the listing carries no
 * company AND the title is distinctive enough to identify one role on its own.
 */
export function matchesRole(job: { title: string; company?: string; url?: string }, idx: RoleIndex): boolean {
  const u = (job.url ?? "").trim();
  if (u && idx.url.has(u)) return true;
  const t = normTitle(job.title);
  const co = normCompany(job.company ?? "");
  return co ? idx.soft.has(`${t}|${co}`) : isDistinctiveTitle(t) && idx.title.has(t);
}

/** Human label for a note in a log line / the `duplicateOf` field. */
const roleLabel = (n: JobNote): string =>
  `${n.data.title ?? "(untitled)"} — ${n.data.company || n.data.source || "?"}`;

/** Drop any active Opportunities note (lead/interested/tailoring) whose role is
 *  already in Applied — you're not pulling the same job twice. */
async function dropOpportunitiesAlreadyApplied(notes: JobNote[], idx: RoleIndex): Promise<number> {
  let dropped = 0;
  for (const n of notes) {
    const s = (n.data.status ?? "lead") as JobStatus;
    if (!ACTIVE_OPP.has(s)) continue;
    const hit = findDuplicate(n, idx);
    if (hit) {
      await dropAsDuplicate(String(n.data.id), roleLabel(hit));
      dropped++;
      console.log(`[applied] dropped Opportunities dup of an Applied role: "${n.data.title}" (${n.data.company || "no company"})`);
    }
  }
  return dropped;
}

export interface DedupeOpportunitiesResult {
  scanned: number;
  dropped: number;
  vsApplied: number;
  vsDropped: number;
  vsSelf: number;
  entries: string[];
  /** Job ids moved to Dropped, so a caller can exclude them from its own tallies. */
  droppedIds: string[];
}

/**
 * Which copy of a duplicated role survives the sweep.
 *
 * Progress the user has made outranks everything: a tailored "Application Ready" note
 * carries a generated resume and cover letter, so keeping the pristine Seek lead over it
 * and dropping the tailored copy would throw that work away. Only between notes at the
 * same stage does the source decide, and there Seek wins because it carries the fullest
 * description (same order the cross-site search de-dupe uses).
 */
const STAGE_RANK: Record<string, number> = { tailoring: 0, interested: 1, lead: 2 };

function keepPriority(n: JobNote): [number, number] {
  const status = String(n.data.status ?? "lead");
  return [STAGE_RANK[status] ?? 3, SOURCE_RANK[String(n.data.source ?? "other")] ?? 9];
}

/**
 * Sweep the active Opportunities columns for roles the board already holds a decision on,
 * and drop them as duplicates.
 *
 * Three passes, in order of how much the match is worth trusting:
 *  1. against Applied / Unsuccessful — you already sent an application for that role,
 *  2. against Dropped — you already said no (or a run dropped it as expired/off-target),
 *  3. against the rest of Opportunities — the same ad listed on two sites, arriving under
 *     two ids. The copy from the higher-priority source is kept (Seek carries the fullest
 *     description), the other is dropped.
 *
 * Every drop records `dropReason: duplicate` and which note it duplicates, so nothing here
 * is mistaken later for a decision the user made. `dryRun` reports without writing.
 */
export async function dedupeOpportunities(
  opts: { dryRun?: boolean } = {},
): Promise<DedupeOpportunitiesResult> {
  const { dryRun = false } = opts;
  const notes = await listJobNotes();
  const active = notes.filter((n) => ACTIVE_OPP.has(String(n.data.status ?? "lead") as JobStatus));
  const out: DedupeOpportunitiesResult = {
    scanned: active.length,
    dropped: 0,
    vsApplied: 0,
    vsDropped: 0,
    vsSelf: 0,
    entries: [],
    droppedIds: [],
  };

  const drop = async (n: JobNote, hit: JobNote, why: string): Promise<void> => {
    out.dropped++;
    out.droppedIds.push(String(n.data.id ?? ""));
    out.entries.push(`${roleLabel(n)}  →  duplicate of ${roleLabel(hit)} (${why})`);
    console.log(`[dedupe-opps] ${why}: dropped "${n.data.title}" (${n.data.company || "no company"}) — duplicate of ${roleLabel(hit)}`);
    if (!dryRun) await dropAsDuplicate(String(n.data.id), roleLabel(hit));
  };

  const decided = await loadDecidedIndex(notes);
  const droppedIdx = buildDroppedIndex(notes);
  // Seen roles within Opportunities. The copy worth keeping claims the key first, so the
  // one that gets dropped is the thinner / less-progressed of the pair (see keepPriority).
  const kept: RoleIndex = { soft: new Map(), title: new Map(), url: new Map(), size: 0 };
  const ordered = [...active].sort((a, b) => {
    const [sa, ra] = keepPriority(a);
    const [sb, rb] = keepPriority(b);
    return sa - sb || ra - rb;
  });

  for (const n of ordered) {
    const inDecided = findDuplicate(n, decided);
    if (inDecided) {
      out.vsApplied++;
      await drop(n, inDecided, "already applied");
      continue;
    }
    const inDropped = findDuplicate(n, droppedIdx);
    if (inDropped) {
      out.vsDropped++;
      await drop(n, inDropped, "already dropped");
      continue;
    }
    const inKept = findDuplicate(n, kept);
    if (inKept) {
      out.vsSelf++;
      await drop(n, inKept, "listed twice");
      continue;
    }
    addToIndex(kept, n);
  }

  console.log(
    `[dedupe-opps] ${dryRun ? "would drop" : "dropped"} ${out.dropped} of ${out.scanned} opportunit(ies) — ` +
      `${out.vsApplied} already applied · ${out.vsDropped} already dropped · ${out.vsSelf} listed twice`,
  );
  return out;
}

/**
 * Drop LinkedIn job notes that duplicate a Seek note. Seek carries the full
 * description; the LinkedIn copy usually has none, so when the same role exists
 * on both we keep Seek and move the LinkedIn note to Dropped. Matches on
 * normalized title + company; LinkedIn's company is often blank, so a title-only
 * match is accepted when the Seek title is specific enough.
 */
export async function dedupeLinkedInAgainstSeek(): Promise<{ dropped: number }> {
  const notes = await listJobNotes();
  const active = notes.filter((n) => {
    const s = (n.data.status ?? "lead") as JobStatus;
    return s !== "dropped" && s !== "rejected";
  });
  // Index Seek roles by url, title+company, and title alone.
  const seek: RoleIndex = { soft: new Map(), title: new Map(), url: new Map(), size: 0 };
  for (const n of active) if (n.data.source === "seek") addToIndex(seek, n);
  let dropped = 0;
  for (const n of active) {
    if (n.data.source !== "linkedin") continue;
    // Same company+title, or LinkedIn has no company but a Seek role shares a distinctive title.
    const dup = findDuplicate(n, seek);
    if (dup) {
      await dropAsDuplicate(String(n.data.id), roleLabel(dup));
      dropped++;
      console.log(`[dedupe] dropped LinkedIn dup of Seek: "${n.data.title}" (${n.data.company || "no company"})`);
    }
  }
  console.log(`[dedupe] done — ${dropped} LinkedIn duplicate(s) dropped`);
  return { dropped };
}
