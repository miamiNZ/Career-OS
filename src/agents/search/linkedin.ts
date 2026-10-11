import type { Job } from "../../types.js";
import type { SearchConfig } from "../../searchConfig.js";
import { mapEmploymentType, detectWorkArrangement, decodeEntities } from "./classify.js";

const ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

/**
 * LinkedIn search agent. Uses the public "jobs-guest" endpoint (no auth) and
 * parses the returned HTML card list. LinkedIn aggressively rate-limits guest
 * requests, so this is best-effort: an empty/blocked response yields [] rather
 * than throwing, so the rest of the pipeline still runs.
 */
/**
 * LinkedIn resolves a location string against its own place graph, and a bare NZ region
 * ("Waikato") is ambiguous enough there to return nothing. Qualifying it with the
 * country makes region-scoped searches (the local tracks) actually return jobs.
 */
function linkedInLocation(location: string): string {
  const loc = location.trim() || "New Zealand";
  return /new zealand|\bnz\b/i.test(loc) ? loc : `${loc}, New Zealand`;
}

export async function searchLinkedIn(query: string, cfg: SearchConfig): Promise<Job[]> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    keywords: query,
    location: linkedInLocation(cfg.location),
    sortBy: "DD",
    start: "0",
  }).toString();

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" } });
  if (!res.ok) return [];
  const html = await res.text();
  if (html.trim().length < 200) return []; // rate-limited / empty
  return parseCards(html, cfg.maxResultsPerSite);
}

function parseCards(html: string, limit: number): Job[] {
  const jobs: Job[] = [];
  const now = new Date().toISOString();
  // Each result is a <div ... data-entity-urn="urn:li:jobPosting:ID"> ... </li>
  const cardRe = /data-entity-urn="urn:li:jobPosting:(\d+)"([\s\S]*?)(?=data-entity-urn="urn:li:jobPosting:|<\/ul>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && jobs.length < limit) {
    const id = m[1] ?? "";
    const block = m[2] ?? "";
    const title = pick(block, /base-search-card__title">([\s\S]*?)</);
    const company = pick(block, /base-search-card__subtitle">[\s\S]*?>([\s\S]*?)</) || pick(block, /hidden-nested-link[^>]*>([\s\S]*?)</);
    const location = pick(block, /job-search-card__location">([\s\S]*?)</);
    const time = block.match(/datetime="([^"]+)"/);
    const href = block.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/);
    jobs.push({
      id: `linkedin-${id}`,
      source: "linkedin",
      title: decodeEntities(title),
      company: decodeEntities(company),
      location: decodeEntities(location),
      url: href?.[1] ?? `https://www.linkedin.com/jobs/view/${id}`,
      engagement: "unknown",
      employmentType: mapEmploymentType(title),
      workArrangement: detectWorkArrangement(location, title),
      description: "",
      postedAt: time ? time[1] : undefined,
      ingestedAt: now,
    });
  }
  return jobs;
}

function pick(s: string, re: RegExp): string {
  const m = s.match(re);
  return m && m[1] ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
}
