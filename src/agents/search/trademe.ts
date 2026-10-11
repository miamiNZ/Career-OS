import type { Job } from "../../types.js";
import type { SearchConfig } from "../../searchConfig.js";
import { mapEmploymentType, detectWorkArrangement, decodeEntities } from "./classify.js";

const ENDPOINT = "https://api.trademe.co.nz/v1/Search/Jobs.json";

// The Mac-Chrome UA + Referer (from the proven Dify workflow) are what make the
// public catalogue return full listing fields — including ExtendedBody — with no auth.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.trademe.co.nz/a/jobs",
};

/**
 * TradeMe region ids, as used by `Search/Jobs.json?region=`. The search API takes an id,
 * not a name, and without one every query returns the nationwide top rows — which on a
 * board this Auckland-heavy means a region-scoped track saw no local listings at all and
 * had every result thrown away by the caller's location filter. Ids are stable; they were
 * read back off the API's own `Region` field.
 */
const TRADEME_REGIONS: Record<string, string> = {
  auckland: "1",
  "bay of plenty": "2",
  canterbury: "3",
  gisborne: "4",
  "hawkes bay": "5",
  "manawatu whanganui": "6",
  marlborough: "7",
  "nelson tasman": "8",
  northland: "9",
  otago: "10",
  southland: "11",
  taranaki: "12",
  waikato: "14",
  wellington: "15",
  "west coast": "16",
};

/**
 * Resolve a location term to a TradeMe region id. Matching is done on a flattened name so
 * "Hawke's Bay", "Manawatu / Whanganui" and "Nelson/Tasman" all land, and a town is
 * resolved via its region ("Hamilton" is not a region, "Waikato" is) by the caller
 * passing the region first in its location list. Unknown terms return undefined, which
 * leaves the search nationwide exactly as before.
 */
export function tradeMeRegionId(location: string): string | undefined {
  const key = (location || "")
    .toLowerCase()
    // Apostrophes are dropped, not spaced: "Hawke's Bay" is one word "hawkes", where
    // "/" and "-" separate two ("Manawatu / Whanganui", "Nelson-Tasman").
    .replace(/['’]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return TRADEME_REGIONS[key];
}

export interface TradeMeOptions {
  /** TradeMe region id (see tradeMeRegionId) to scope the search to. */
  region?: string;
  /**
   * TradeMe job category to browse (e.g. "5000-5112-" = IT). With no search string this
   * returns every job TradeMe files under that category in the region — the same
   * whole-market view Seek's `classification` gives, and the only way to catch a local
   * listing whose title uses none of the words a keyword track guesses at.
   */
  category?: string;
}

/**
 * TradeMe Jobs search agent. The search payload already carries the full job description.
 * `titleOverride` lets the extra-search track search a different title (e.g. "courier")
 * than the resume-derived primary `cfg.tradeMeTitle`. Pass `titleOverride: ""` with
 * `opts.category` to browse a whole category instead of running a keyword query.
 */
export async function searchTradeMe(
  cfg: SearchConfig,
  titleOverride?: string,
  opts: TradeMeOptions = {},
): Promise<Job[]> {
  const url = new URL(ENDPOINT);
  // A category browse deliberately runs with no search string; everything else keeps the
  // old behaviour of falling back to the configured broad title.
  const search = titleOverride ?? cfg.tradeMeTitle;
  const params: Record<string, string> = { rows: String(cfg.maxResultsPerSite) };
  if (search) params.search_string = search;
  else if (!opts.category) params.search_string = cfg.tradeMeTitle;
  if (opts.region) params.region = opts.region;
  if (opts.category) params.category = opts.category;
  url.search = new URLSearchParams(params).toString();

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`TradeMe search ${res.status}`);
  const data: any = await res.json();
  const now = new Date().toISOString();

  return (data.List ?? []).map((j: any): Job => {
    const bullets: string[] = j.AdditionalData?.BulletPoints ?? [];
    // ExtendedBody is the full HTML ad; Body is a shorter summary. Prefer the fuller one.
    const description = htmlToText(j.ExtendedBody || j.Body || "");
    const location = j.JobLocation || [j.Suburb, j.Region].filter(Boolean).join(", ");
    return {
      id: `trademe-${j.ListingId}`,
      source: "trademe",
      title: decodeEntities(j.Title ?? ""),
      company: decodeEntities(j.Company || ""),
      location,
      url: `https://www.trademe.co.nz/a/jobs/listing/${j.ListingId}`,
      salaryText: j.PayBenefits || j.PriceDisplay || undefined,
      engagement: mapEngagement(j.JobType),
      employmentType: mapEmploymentType(j.JobType),
      workArrangement: detectWorkArrangement("", `${j.Title} ${location} ${description}`),
      description: [description, bullets.join("\n")].filter(Boolean).join("\n\n").trim(),
      postedAt: parseMsDate(j.StartDate),
      ingestedAt: now,
    };
  });
}

function mapEngagement(t: unknown): Job["engagement"] {
  const s = String(t ?? "").toLowerCase();
  if (s.includes("permanent") || s === "ft" || s.includes("full")) return "permanent";
  if (s.includes("contract") || s.includes("temp") || s === "c") return "contract";
  return "unknown";
}

/** TradeMe serializes dates as "/Date(1780547436257)/". */
function parseMsDate(s: unknown): string | undefined {
  const m = String(s ?? "").match(/\/Date\((\d+)/);
  return m ? new Date(Number(m[1])).toISOString() : undefined;
}

/** Collapse the HTML ad body to readable plain text, keeping paragraph/list breaks. */
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
