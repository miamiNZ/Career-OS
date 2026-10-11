import type { Job } from "../../types.js";
import { mapEmploymentType, detectWorkArrangement } from "./classify.js";

/**
 * Description enrichment: for each job, make a second HTTP call to its listing
 * URL and pull the full job description out of the page.
 *
 * Reality per site (verified):
 *  - LinkedIn: the guest "jobPosting" fragment returns the full HTML body. ✓
 *  - Seek: a second call to the public GraphQL jobDetails endpoint (no auth). ✓
 *  - TradeMe: not needed here — its search payload already carries ExtendedBody.
 *  - Indeed: not needed either — its GraphQL search returns the full ad body.
 *
 * Every fetch is best-effort: a failure leaves the job's existing description
 * untouched and never sinks the run.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CONCURRENCY = 4;

/**
 * Sources whose search payload already carries the full ad body, so `fetchDescription`
 * has nothing to add. Without this, every ZEIL job logged a "no full description"
 * warning — ~90 lines a run, drowning the LinkedIn rate-limit failures that matter.
 */
const SELF_DESCRIBING = new Set<Job["source"]>(["trademe", "indeed", "zeil"]);

/** Mutates each job in place with a fuller description when one can be fetched. */
export async function enrichDescriptions(jobs: Job[]): Promise<{ enriched: number }> {
  let enriched = 0;
  let thin = 0; // ended up with little/no description
  let i = 0;
  console.log(`[enrich] fetching full descriptions for ${jobs.length} job(s)…`);

  async function worker(): Promise<void> {
    while (i < jobs.length) {
      const job = jobs[i++];
      if (!job) continue;
      const before = job.description?.length ?? 0;
      try {
        const full = await fetchDescription(job);
        if (full && full.length > before) {
          job.description = full;
          enriched++;
          // The fuller text can reveal type / remote the search card lacked.
          if (job.employmentType === "unknown") job.employmentType = mapEmploymentType(`${job.title} ${full}`);
          if (job.workArrangement === "unknown") job.workArrangement = detectWorkArrangement("", full);
        } else if (SELF_DESCRIBING.has(job.source)) {
          // expected — these sources' search payloads already carry the full ad body,
          // so there is nothing to enrich and nothing worth warning about.
        } else if (full == null) {
          console.warn(`[enrich] ${job.source} no full description for "${job.title}" (${job.id}) — kept ${before} chars from search card`);
        }
      } catch (e) {
        console.warn(`[enrich] ${job.source} fetch failed for "${job.title}" (${job.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if ((job.description?.length ?? 0) < 40) thin++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  console.log(`[enrich] done — ${enriched} enriched, ${thin} still thin/empty of ${jobs.length}`);
  return { enriched };
}

async function fetchDescription(job: Job): Promise<string | null> {
  switch (job.source) {
    case "linkedin":
      return fetchLinkedIn(job);
    case "seek":
      return fetchSeek(job);
    case "trademe":
      return fetchTradeMe(job);
    default:
      return null;
  }
}

// --- TradeMe: listing-detail endpoint (full Body, no auth) -------------------
// The search list sometimes omits ExtendedBody; the per-listing detail call
// returns the full ad Body. Same Mac-Chrome UA + Referer the search uses.
const TM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.trademe.co.nz/a/jobs",
};
async function fetchTradeMe(job: Job): Promise<string | null> {
  const id = job.id.replace(/^trademe-/, "");
  if (!/^\d+$/.test(id)) return null;
  const res = await fetch(`https://api.trademe.co.nz/v1/Listings/${id}.json`, {
    headers: TM_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (TradeMe listing)`);
  const j: any = await res.json();
  const bullets: string[] = j?.AdditionalData?.BulletPoints ?? [];
  const html = j?.ExtendedBody || j?.Body || "";
  const text = [htmlToText(String(html)), bullets.join("\n")].filter(Boolean).join("\n\n").trim();
  return text.length > 40 ? text : null;
}

// --- LinkedIn: guest jobPosting fragment (full text) -------------------------
async function fetchLinkedIn(job: Job): Promise<string | null> {
  const id = job.id.replace(/^linkedin-/, "");
  if (!/^\d+$/.test(id)) return null;
  const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (LinkedIn guest API likely rate-limiting)`);
  const html = await res.text();
  const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
  return m && m[1] ? htmlToText(m[1]) || null : null;
}

// --- Seek: public GraphQL jobDetails (full HTML body + dates, no auth) ---------
const SEEK_GRAPHQL = "https://nz.seek.com/graphql";
const SEEK_QUERY =
  "query($id:ID!){jobDetails(id:$id){job{content(platform:WEB) listedAt{dateTimeUtc} expiresAt{dateTimeUtc}}}}";

async function fetchSeek(job: Job): Promise<string | null> {
  const id = job.id.replace(/^seek-/, "");
  if (!/^\d+$/.test(id)) return null;
  const res = await fetch(SEEK_GRAPHQL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://nz.seek.com",
    },
    body: JSON.stringify({ query: SEEK_QUERY, variables: { id } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (Seek GraphQL)`);
  const j: any = await res.json();
  // Seek returns jobDetails: null when the listing has been removed/expired. Treat that
  // as a confirmed-gone signal so the caller can drop it from the board.
  if (j?.data && j.data.jobDetails === null) {
    job.expired = true;
    return null;
  }
  const jd = j?.data?.jobDetails?.job;
  // An expiresAt already in the past also means the listing has closed.
  const expAt = jd?.expiresAt?.dateTimeUtc;
  if (typeof expAt === "string" && expAt && new Date(expAt).getTime() < Date.now()) {
    job.expired = true;
  }
  // Best-effort date capture — the listing carries an exact posted + closing date.
  const closes = jd?.expiresAt?.dateTimeUtc;
  if (typeof closes === "string" && closes) job.closesAt = closes;
  const listed = jd?.listedAt?.dateTimeUtc;
  if (typeof listed === "string" && listed && !job.postedAt) job.postedAt = listed;
  const content = jd?.content;
  if (typeof content === "string" && content.trim()) {
    const text = htmlToText(content);
    if (text.length > 40) return text;
  }
  return null;
}

// --- shared extraction helpers ----------------------------------------------

/** Collapse HTML to readable plain text, preserving list/paragraph breaks. */
function htmlToText(h: string): string {
  return h
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
