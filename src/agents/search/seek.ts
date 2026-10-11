import type { Job } from "../../types.js";
import type { SearchConfig } from "../../searchConfig.js";
import { mapEmploymentType, detectWorkArrangement, decodeEntities } from "./classify.js";

const ENDPOINT = "https://www.seek.co.nz/api/jobsearch/v5/search";

export interface SeekOptions {
  /**
   * Seek classification id to restrict the search to (e.g. "6281" = Information &
   * Communication Technology). Combined with an empty `query` this browses every job
   * Seek itself files under that category in the search area, which is the only way to
   * see a whole local market: keyword queries only ever return the roles whose ad text
   * happens to use the words you guessed, and a small region's entire ICT list can be
   * small enough (single figures) that guessing is what loses jobs.
   */
  classification?: string;
}

/** Seek search agent. Hits the undocumented v5 JSON search API (no auth). */
export async function searchSeek(
  query: string,
  cfg: SearchConfig,
  opts: SeekOptions = {},
): Promise<Job[]> {
  const url = new URL(ENDPOINT);
  const params: Record<string, string> = {
    siteKey: "NZ-Main",
    where: cfg.location,
    page: "1",
    pageSize: String(cfg.maxResultsPerSite),
    // Relevance ranks against the keywords; with none to rank against (a classification
    // browse) it degrades to an arbitrary order, so take the newest listings instead.
    sortMode: query.trim() ? "Relevance" : "ListedDate",
  };
  if (query.trim()) params.keywords = query;
  if (opts.classification) params.classification = opts.classification;
  url.search = new URLSearchParams(params).toString();

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Seek search ${res.status}`);
  const data: any = await res.json();
  const now = new Date().toISOString();

  return (data.data ?? []).map((j: any): Job => {
    const bullets: string[] = Array.isArray(j.bulletPoints) ? j.bulletPoints : [];
    const workType = Array.isArray(j.workTypes) ? j.workTypes[0] : j.workType;
    const arrangementLabel =
      j.workArrangements?.displayText || j.workArrangements?.data?.[0]?.label?.text;
    return {
      id: `seek-${j.id}`,
      source: "seek",
      title: decodeEntities(j.title ?? ""),
      company: decodeEntities(j.advertiser?.description || j.companyName || ""),
      location: j.locations?.[0]?.label || j.jobLocation?.label || "",
      url: `https://www.seek.co.nz/job/${j.id}`,
      salaryText: j.salaryLabel || undefined,
      engagement: mapEngagement(workType),
      employmentType: mapEmploymentType(workType),
      workArrangement: detectWorkArrangement(arrangementLabel, j.teaser ?? ""),
      description: [j.teaser, ...bullets].filter(Boolean).join("\n"),
      postedAt: j.listingDate || undefined,
      ingestedAt: now,
    };
  });
}

function mapEngagement(wt: unknown): Job["engagement"] {
  const s = String(wt ?? "").toLowerCase();
  if (s.includes("permanent") || s.includes("full")) return "permanent";
  if (s.includes("contract")) return "contract";
  return "unknown";
}
