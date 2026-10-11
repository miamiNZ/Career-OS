import type { Job } from "../../types.js";
import type { SearchConfig } from "../../searchConfig.js";
import { mapEmploymentType, detectWorkArrangement, decodeEntities } from "./classify.js";

// Indeed's website and RSS feed both sit behind a bot wall that answers any scripted
// request with a 403 challenge page. The mobile app talks to a GraphQL API on a separate
// host that has no such wall: it only wants the app's own (public, shipped-in-the-binary)
// API key and a country header. That API also returns the full ad body with each result,
// so Indeed jobs need no second description fetch.
const ENDPOINT = "https://apis.indeed.com/graphql";
const API_KEY = "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "indeed-api-key": API_KEY,
  "indeed-co": "NZ",
  "indeed-locale": "en-NZ",
  "indeed-app-info": "appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1",
};

const SEARCH_QUERY = `
query JobSearch($what: String, $where: String!, $limit: Int) {
  jobSearch(what: $what, location: { where: $where, radius: 50, radiusUnit: KILOMETERS }, limit: $limit, sort: RELEVANCE) {
    results {
      job {
        key
        title
        datePublished
        expired
        description { html }
        location { formatted { long } }
        compensation {
          baseSalary { unitOfWork range { ... on Range { min max } } }
          estimated { baseSalary { unitOfWork range { ... on Range { min max } } } }
        }
        attributes { label }
        employer { name }
      }
    }
  }
}`;

/** Indeed (nz.indeed.com) search agent, via the mobile app's GraphQL API (no login). */
export async function searchIndeed(query: string, cfg: SearchConfig): Promise<Job[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        what: query,
        where: cfg.location.trim() || "New Zealand",
        limit: cfg.maxResultsPerSite,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Indeed search ${res.status}`);
  const data: any = await res.json();
  if (data.errors?.length) throw new Error(`Indeed search: ${data.errors[0]?.message ?? "GraphQL error"}`);
  const now = new Date().toISOString();

  return (data.data?.jobSearch?.results ?? [])
    .map((r: any) => r?.job)
    .filter((j: any) => j?.key && !j.expired)
    .map((j: any): Job => {
      const labels: string[] = (j.attributes ?? []).map((a: any) => String(a?.label ?? ""));
      const labelText = labels.join(" ");
      const title = decodeEntities(j.title ?? "");
      const pay = j.compensation?.baseSalary ?? j.compensation?.estimated?.baseSalary;
      return {
        id: `indeed-${j.key}`,
        source: "indeed",
        title,
        company: decodeEntities(j.employer?.name ?? ""),
        location: j.location?.formatted?.long ?? "",
        url: `https://nz.indeed.com/viewjob?jk=${j.key}`,
        salaryText: salaryText(pay, !j.compensation?.baseSalary),
        engagement: mapEngagement(labelText),
        employmentType: mapEmploymentType(labelText),
        workArrangement: detectWorkArrangement(labelText, title),
        description: htmlToText(String(j.description?.html ?? "")),
        postedAt: j.datePublished ? new Date(j.datePublished).toISOString() : undefined,
        ingestedAt: now,
      };
    });
}

/**
 * Indeed tags a listing with labels like "Full-time", "Permanent", "Contract",
 * "Fixed term". Only the last few say anything about engagement.
 */
function mapEngagement(labels: string): Job["engagement"] {
  const s = labels.toLowerCase();
  if (/permanent/.test(s)) return "permanent";
  if (/contract|fixed[\s-]?term|temporary/.test(s)) return "contract";
  return "unknown";
}

/** "$90,000 – $110,000 a year". Indeed's own estimates are marked so they aren't read as the ad's. */
function salaryText(pay: any, estimated: boolean): string | undefined {
  const min = pay?.range?.min;
  const max = pay?.range?.max;
  if (typeof min !== "number" && typeof max !== "number") return undefined;
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-NZ")}`;
  const range =
    typeof min === "number" && typeof max === "number" && min !== max
      ? `${fmt(min)} – ${fmt(max)}`
      : fmt((min ?? max) as number);
  const unit = String(pay?.unitOfWork ?? "").toLowerCase();
  const per = unit ? ` ${unit === "hour" ? "an" : "a"} ${unit}` : "";
  return `${range}${per}${estimated ? " (Indeed estimate)" : ""}`;
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
