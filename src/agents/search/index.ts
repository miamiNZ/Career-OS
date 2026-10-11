import type { Job } from "../../types.js";
import type { SearchConfig, SearchTrack } from "../../searchConfig.js";
import { vlog } from "../../logbus.js";
import { mapLimit } from "../../concurrency.js";
import { searchSeek } from "./seek.js";
import { searchTradeMe, tradeMeRegionId } from "./trademe.js";
import { searchLinkedIn } from "./linkedin.js";
import { searchZeil } from "./zeil.js";
import { searchIndeed } from "./indeed.js";

export interface SearchResult {
  jobs: Job[];
  /** Per-site outcome for logging: counts or an error message. */
  bySite: Record<string, { count: number; error?: string }>;
}

type Runners = Record<string, () => Promise<Job[]>>;

/**
 * Run the enabled site runners in parallel and collect their jobs + per-site
 * outcome. One site failing (e.g. LinkedIn rate-limit) never sinks the others.
 * Returns raw (un-deduped) jobs so callers can merge across queries first.
 */
async function gather(
  cfg: SearchConfig,
  runners: Runners,
): Promise<{ jobs: Job[]; bySite: SearchResult["bySite"] }> {
  const bySite: SearchResult["bySite"] = {};
  const all: Job[] = [];
  await Promise.all(
    cfg.sites.map(async (site) => {
      const runner = runners[site];
      if (!runner) return;
      const t0 = Date.now();
      try {
        const jobs = await runner();
        bySite[site] = { count: (bySite[site]?.count ?? 0) + jobs.length };
        all.push(...jobs);
        vlog(`[search] ${site}: ${jobs.length} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        bySite[site] = { count: bySite[site]?.count ?? 0, error: err };
        vlog(`[search] ${site}: ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s — ${err}`);
      }
    }),
  );
  return { jobs: all, bySite };
}

const uniq = (xs: string[]): string[] => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];

/**
 * Run the keyword sites once per query and TradeMe once per TradeMe query, merging
 * every site's results before a single dedupe pass. TradeMe is split out because its
 * search takes one broad title rather than a keyword blob, so the two tracks don't
 * always want the same string.
 */
async function runQueries(
  cfg: SearchConfig,
  queries: string[],
  tradeMeQueries: string[],
  tradeMeOpts: { region?: string } = {},
): Promise<SearchResult> {
  const all: Job[] = [];
  const bySite: SearchResult["bySite"] = {};
  const merge = (r: SearchResult["bySite"]) => {
    for (const [site, v] of Object.entries(r)) {
      const cur = bySite[site] ?? { count: 0 };
      bySite[site] = { count: cur.count + v.count, error: v.error ?? cur.error };
    }
  };

  // Queries used to run strictly one after another, so a run with 8 target roles paid 8
  // full round-trips of latency per site for calls that don't depend on each other. They
  // now overlap, bounded so the boards still see a sane request rate — LinkedIn's guest
  // endpoint rate-limits hard, and a burst there returns nothing for the whole run.
  const results = await mapLimit(
    [
      ...queries.map((q) => () =>
        gather(cfg, {
          seek: () => searchSeek(q, cfg),
          linkedin: () => searchLinkedIn(q, cfg),
          zeil: () => searchZeil(q, cfg),
          indeed: () => searchIndeed(q, cfg),
        }),
      ),
      ...tradeMeQueries.map((q) => () =>
        gather(cfg, { trademe: () => searchTradeMe(cfg, q, tradeMeOpts) }),
      ),
    ],
    QUERY_CONCURRENCY,
    (run) => run(),
  );
  for (const r of results) {
    all.push(...r.jobs);
    merge(r.bySite);
  }
  return { jobs: dedupe(all), bySite };
}

/**
 * Queries in flight at once. Each one fans out to every enabled site, so the real request
 * rate per site is this number — 3 is comfortably below what Seek/LinkedIn tolerate while
 * still cutting an 8-query run's search phase to roughly a third.
 */
const QUERY_CONCURRENCY = 3;

/**
 * Point a track's searches at its own area. Seek and LinkedIn take the location as a
 * query parameter and ZEIL filters on it, so a region-scoped track has to override
 * `cfg.location` — filtering nationwide results afterwards throws away the 20 slots the
 * boards gave us before the local jobs are ever reached.
 */
function forLocation(cfg: SearchConfig, locations: string[]): SearchConfig {
  const primary = locations[0]?.trim();
  return primary ? { ...cfg, location: primary } : cfg;
}

/**
 * Primary track: run every enabled search agent once per target-role query, then dedupe.
 * Multiple narrow role titles are used instead of one wide keyword string because the
 * boards rank on title relevance — a single blended query only ever returns one slice
 * of the market (and, for a resume full of architecture, the wrong slice).
 */
export async function searchAll(queries: string[], cfg: SearchConfig): Promise<SearchResult> {
  const list = uniq(queries);
  // TradeMe also gets the configured `trademe_title` so that setting keeps working.
  return runQueries(cfg, list, uniq([cfg.tradeMeTitle, ...list]));
}

/**
 * Run one extra track's keyword searches (e.g. "courier", "delivery driver", or the
 * local IT titles) as a separate category alongside the resume-derived primary search.
 * Each query hits the keyword sites (Seek/LinkedIn/Indeed/ZEIL) and is also used as the TradeMe
 * title, so a different kind of role surfaces. Results are merged + deduped across all
 * queries. `locations` scopes the search itself, not just the results.
 */
export async function searchExtra(
  queries: string[],
  cfg: SearchConfig,
  locations: string[] = [],
): Promise<SearchResult> {
  const list = uniq(queries);
  return runQueries(forLocation(cfg, locations), list, list);
}

/** A track's results, plus the ids the boards themselves classified into its category. */
export interface TrackResult extends SearchResult {
  /**
   * Ids that came from a Seek `classification` / TradeMe `category` browse. The board has
   * already filed these under the category the track asked for, so the caller's
   * `title_match` guard must not be applied to them — that guard exists to clean up
   * keyword results, and it demonstrably discards real ICT listings whose titles carry
   * none of its words ("Product Manager - Lending", "Senior Project Manager").
   */
  categoryIds: Set<string>;
}

/**
 * Browse a track's whole category on the boards that expose one, with no keyword at all.
 *
 * A keyword track can only ever return the roles whose ad text happens to use the words
 * you thought to list; in a small region the entire IT market can be single
 * figures, so one unguessed title is a job missed outright. Seek and TradeMe both let a
 * search be scoped to their own category taxonomy instead, which turns "any IT job near
 * home" from a guessing game into an exhaustive listing. LinkedIn's guest endpoint, Indeed and
 * ZEIL expose no such filter, so they stay keyword-only.
 */
async function runBrowse(cfg: SearchConfig, track: SearchTrack): Promise<SearchResult> {
  const region = tradeMeRegionId(track.locations[0] ?? "");
  const runners: Array<() => Promise<SearchResult>> = [];

  if (cfg.sites.includes("seek")) {
    for (const classification of track.seekClassifications) {
      runners.push(() =>
        gather(cfg, { seek: () => searchSeek("", cfg, { classification }) }),
      );
    }
  }
  if (cfg.sites.includes("trademe")) {
    for (const category of track.tradeMeCategories) {
      runners.push(() =>
        gather(cfg, { trademe: () => searchTradeMe(cfg, "", { category, region }) }),
      );
    }
  }
  if (!runners.length) return { jobs: [], bySite: {} };

  const results = await mapLimit(runners, QUERY_CONCURRENCY, (run) => run());
  const jobs: Job[] = [];
  const bySite: SearchResult["bySite"] = {};
  for (const r of results) {
    jobs.push(...r.jobs);
    for (const [site, v] of Object.entries(r.bySite)) {
      const cur = bySite[site] ?? { count: 0 };
      bySite[site] = { count: cur.count + v.count, error: v.error ?? cur.error };
    }
  }
  return { jobs, bySite };
}

/**
 * Run one extra track end to end: its keyword searches (as searchExtra) plus a
 * category browse of any board that supports one, merged and deduped together.
 * `locations` scopes the searches themselves, not just the results — TradeMe included,
 * which until now took no location at all and so answered every region-scoped track with
 * the nationwide top rows, all of which the caller's location filter then threw away.
 */
export async function searchTrack(track: SearchTrack, cfg: SearchConfig): Promise<TrackResult> {
  const scoped = forLocation(cfg, track.locations);
  const list = uniq(track.searches);
  const region = tradeMeRegionId(track.locations[0] ?? "");
  const [keyword, browse] = await Promise.all([
    list.length
      ? runQueries(scoped, list, list, { region })
      : Promise.resolve<SearchResult>({ jobs: [], bySite: {} }),
    runBrowse(scoped, track),
  ]);

  const bySite: SearchResult["bySite"] = {};
  for (const part of [keyword, browse]) {
    for (const [site, v] of Object.entries(part.bySite)) {
      const cur = bySite[site] ?? { count: 0 };
      bySite[site] = { count: cur.count + v.count, error: v.error ?? cur.error };
    }
  }
  // Browse results first so that when the same listing arrives both ways the surviving
  // copy is the one carrying the board's own category, and stays exempt from title_match.
  const categoryIds = new Set(browse.jobs.map((j) => j.id));
  return { jobs: dedupe([...browse.jobs, ...keyword.jobs]), bySite, categoryIds };
}

/** Source priority when the same job appears on multiple sites — Seek wins. */
export const SOURCE_RANK: Record<string, number> = { seek: 0, trademe: 1, indeed: 2, zeil: 3, linkedin: 4, other: 5 };

/** Decode the few HTML entities that differ between sources (Seek "&" vs LinkedIn "&amp;"). */
function decode(s: string): string {
  return (s || "").replace(/&amp;/gi, "&").replace(/&#39;|&rsquo;/gi, "'");
}
/** Normalize a company name for soft matching (strip suffixes/punctuation). */
export function normCompany(c?: string): string {
  return decode(c || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(limited|ltd|inc|pty|nz|new zealand|group|holdings)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function normTitle(t: string): string {
  return decode(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Matching two listings on title alone (needed when one carries no company, as
 * LinkedIn and ZEIL often don't) is only safe for a DISTINCTIVE title. A generic one —
 * "Senior Developer", "Software Engineer", "Technical Lead" — is reused across dozens of
 * unrelated employers, so a title-only match would silently discard a brand-new role at a
 * different company. Require several significant words before trusting a title as a
 * fingerprint. Shared with the Applied-duplicate check in orchestrator.ts so both
 * dedupe paths draw the line in the same place.
 */
const MIN_DISTINCTIVE_WORDS = 5;
export function isDistinctiveTitle(normalized: string): boolean {
  return normalized.split(" ").filter(Boolean).length >= MIN_DISTINCTIVE_WORDS;
}

/**
 * Dedupe across sites. Exact id first, then a soft title+company key. When the
 * same role shows on Seek and LinkedIn, keep Seek and drop the LinkedIn copy
 * (Seek carries the full description; LinkedIn's guest API often returns none).
 * A blank-company listing falls back to a title-only key, but only for a title
 * distinctive enough to identify one role (see isDistinctiveTitle).
 */
function dedupe(jobs: Job[]): Job[] {
  // Highest-priority source first so it claims the key and the rest are dropped.
  const ordered = [...jobs].sort(
    (a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9),
  );
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of ordered) {
    const t = normTitle(j.title);
    const co = normCompany(j.company);
    const soft = co ? `${t}|${co}` : "";
    const titleKey = `t:${t}`; // blank-company fallback (LinkedIn / ZEIL)
    const distinctive = isDistinctiveTitle(t);
    if (seen.has(j.id)) continue;
    if (soft && seen.has(soft)) continue;
    if (!co && distinctive && seen.has(titleKey)) continue;
    seen.add(j.id);
    if (soft) seen.add(soft);
    if (distinctive) seen.add(titleKey);
    out.push(j);
  }
  return out;
}
