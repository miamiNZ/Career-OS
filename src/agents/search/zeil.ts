import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from "amazon-cognito-identity-js";
import type { Job } from "../../types.js";
import type { SearchConfig } from "../../searchConfig.js";
import { config } from "../../config.js";
import { singleFlight } from "../../concurrency.js";
import { mapEmploymentType, detectWorkArrangement, decodeEntities } from "./classify.js";

// ZEIL is a login-only NZ job marketplace (Flutter app, no public/anonymous data).
// Its backend is a REST API on api.zeil.ai guarded by an AWS Cognito user pool that
// only allows the SRP auth flow. We sign in with the user's ZEIL credentials via SRP
// to mint a short-lived Cognito ID token, then call the same job-search endpoint the
// web app uses. No browser is needed — the WAF challenge only fronts app.zeil.com, not
// the API host.
const SEARCH_ENDPOINT = "https://api.zeil.ai/zeil/v1/search/job_listing";
const COGNITO_USER_POOL_ID = "ap-southeast-2_kDe59yFNx";
const COGNITO_CLIENT_ID = "68j46qid1b7hmg69bm7k16gujn";
// The web client stamps every API call with this; the API rejects requests without it.
const ZEIL_CLIENT_UA = "zeil;1.5.79(1);WEB;Win32";

// Cache the ID token in-process (it's valid ~24h). A long-running dashboard reuses it
// across runs and only re-authenticates once it's within the expiry skew.
let tokenCache: { token: string; expMs: number } | null = null;
const EXPIRY_SKEW_MS = 60_000;

/**
 * Sign in via Cognito SRP and return a (cached) ID token, or throw if creds are
 * missing/invalid. Wrapped in singleFlight because a run fires several queries at once:
 * without it, every concurrent search would start its own SRP handshake before the first
 * one finished writing the cache.
 */
const getIdToken = singleFlight(async (): Promise<string> => {
  const now = Date.now();
  if (tokenCache && tokenCache.expMs - EXPIRY_SKEW_MS > now) return tokenCache.token;

  const { email, password } = config.zeil;
  if (!email || !password) {
    throw new Error("ZEIL_EMAIL / ZEIL_PASSWORD not set — ZEIL search disabled");
  }

  const pool = new CognitoUserPool({
    UserPoolId: COGNITO_USER_POOL_ID,
    ClientId: COGNITO_CLIENT_ID,
  });
  const user = new CognitoUser({ Username: email, Pool: pool });
  const auth = new AuthenticationDetails({ Username: email, Password: password });

  const token = await new Promise<{ token: string; expMs: number }>((resolve, reject) => {
    user.authenticateUser(auth, {
      onSuccess: (session) => {
        const idToken = session.getIdToken();
        // getExpiration() is unix seconds.
        resolve({ token: idToken.getJwtToken(), expMs: idToken.getExpiration() * 1000 });
      },
      onFailure: (err) => reject(new Error(`ZEIL login failed: ${err?.message || err}`)),
      newPasswordRequired: () =>
        reject(new Error("ZEIL login requires a password reset — sign in via the app first")),
    });
  });

  tokenCache = token;
  return token.token;
});

/**
 * ZEIL search agent. Authenticates via Cognito SRP, then POSTs the keyword search the
 * web app uses. The response carries full job listings (description, salary, location),
 * so no per-listing follow-up fetch is needed.
 */
export async function searchZeil(query: string, cfg: SearchConfig): Promise<Job[]> {
  const token = await getIdToken();

  const url = new URL(SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    offset: "0",
    limit: String(cfg.maxResultsPerSite),
  }).toString();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "zeil-user-agent": ZEIL_CLIENT_UA,
    },
    // The web app sends these filter arrays empty for a plain keyword search.
    body: JSON.stringify({
      keyword: query,
      benefit: [],
      jobScheduleType: [],
      workType: [],
      workPlace: [],
      culture: [],
      industry: [],
      subIndustry: [],
      experienceLevel: [],
      orgIndustry: [],
    }),
  });
  if (res.status === 401 || res.status === 403) {
    tokenCache = null; // stale token — drop so the next run re-authenticates
    throw new Error(`ZEIL search ${res.status} (auth)`);
  }
  if (!res.ok) throw new Error(`ZEIL search ${res.status}`);

  const data: any = await res.json();
  const items: any[] = data?.result?.items ?? [];
  const now = new Date().toISOString();

  const jobs = items.map((jl: any): Job => mapListing(jl, now));
  return filterByLocation(jobs, cfg.location);
}

/** Map a ZEIL jobListing object to the normalized Job shape. */
function mapListing(jl: any, now: string): Job {
  const location = [jl?.location?.city, jl?.location?.region]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // drop "Wellington, Wellington" dupes
    .join(", ");

  // Employment type / work arrangement: use the human-readable `name` (e.g. "Full Time",
  // "On Site") not `code` ("FULL_TIME"/"ON_SITE") — underscores defeat the classifiers.
  const workTypeName = jl?.jobListingWorkType?.[0]?.workType?.name ?? "";
  const workPlaceName = jl?.workPlace?.name ?? "";

  const description = extractDescription(jl);
  const employmentType = mapEmploymentType(workTypeName);

  return {
    id: `zeil-${jl?.id}`,
    source: "zeil",
    title: decodeEntities(jl?.title ?? ""),
    company: decodeEntities(
      jl?.organisation?.name || jl?.organisation?.tradingName || jl?.organisation?.displayName || "",
    ),
    location,
    url: `https://zeil.com/jobs/job/${jl?.id}`,
    // Like the Seek/TradeMe agents, emit only the raw salary string and leave the numeric
    // salaryMin/Max unset so ZEIL isn't the only source the salary hard filter acts on.
    salaryText: parseCompensation(jl?.jobListingCompensation?.[0]),
    engagement: mapEngagement(employmentType, `${jl?.title ?? ""} ${description}`),
    employmentType,
    workArrangement: detectWorkArrangement(workPlaceName, `${jl?.title ?? ""} ${description}`),
    description,
    postedAt: jl?.listingDate || undefined,
    closesAt: jl?.closingDate || undefined,
    ingestedAt: now,
  };
}

/** ZEIL has no permanent/contract field — infer from the (mapped) employment type then text. */
function mapEngagement(employmentType: Job["employmentType"], text: string): Job["engagement"] {
  if (employmentType === "contract") return "contract";
  const s = text.toLowerCase();
  if (/\b(fixed[\s-]?term|contract role|contract position|temporary|temp role)\b/.test(s))
    return "contract";
  if (/\bpermanent\b/.test(s)) return "permanent";
  return "unknown";
}

/**
 * Build a human-readable salary string from a ZEIL compensation entry, using the raw
 * amount that matches the stated frequency (e.g. "AUD 90 - 170 /hr", "NZD 120,000 - 150,000 /yr").
 */
function parseCompensation(c: any): string | undefined {
  if (!c) return undefined;
  const min = num(c.amountMin ?? c.amount);
  const max = num(c.amountMax);
  if (min === undefined && max === undefined) return undefined;

  const currency = String(c.currency || "").toUpperCase();
  const freq = c.frequency?.abbreviation || "";
  const fmt = (n: number) => n.toLocaleString("en-NZ", { maximumFractionDigits: 0 });
  const range =
    min !== undefined && max !== undefined && max !== min
      ? `${fmt(min)} - ${fmt(max)}`
      : fmt((min ?? max)!);
  return ([currency, range].filter(Boolean).join(" ") + (freq ? ` ${freq}` : "")).trim();
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * ZEIL stores the job body as a Quill rich-text Delta (a JSON array of {insert, attributes}
 * ops), not HTML. Concatenate the string inserts to get clean text; fall back to the
 * pre-normalised plain field, then to HTML stripping, for any listing that differs.
 */
function extractDescription(jl: any): string {
  const raw = jl?.description;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const ops = JSON.parse(raw);
      if (Array.isArray(ops)) {
        const text = ops.map((o) => (typeof o?.insert === "string" ? o.insert : "")).join("");
        if (text.trim()) return normalizeText(text);
      }
    } catch {
      // not a Delta after all — fall through
    }
  }
  if (jl?.normalisedDescription) return normalizeText(String(jl.normalisedDescription));
  return htmlToText(String(raw || ""));
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The search API takes no location parameter, so when the config pins a specific area
 * (not nationwide) we filter results to listings whose location mentions it. Remote roles
 * are always kept.
 */
function filterByLocation(jobs: Job[], location: string): Job[] {
  const loc = location.trim().toLowerCase();
  if (!loc || /\b(new zealand|nationwide|all|anywhere)\b/.test(loc)) return jobs;
  return jobs.filter(
    (j) => j.workArrangement === "remote" || (j.location || "").toLowerCase().includes(loc),
  );
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
