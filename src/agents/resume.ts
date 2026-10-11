import Anthropic from "@anthropic-ai/sdk";
import matter from "gray-matter";
import { config } from "../config.js";
import { loadProfile } from "../vault.js";
import type { SearchConfig } from "../searchConfig.js";
import { isCappedQuery, titleCapsFor, type TitleCap } from "../titleCaps.js";

export interface ResumeContext {
  /** Full resume markdown — fed to the scorer + application agent. */
  resumeText: string;
  /** Primary keyword search for the job sites. Always `searchQueries[0]`. */
  searchQuery: string;
  /** One job-board query per target role — each is run as its own search. */
  searchQueries: string[];
  /** Up to ~10 skill keywords pulled from the resume (used for tailoring + heuristic scoring). */
  keywords: string[];
}

/** Last-resort query when the profile yields nothing usable. */
const FALLBACK_QUERY = "software developer";

/** Running more than this many primary searches costs time for diminishing returns. */
const MAX_QUERIES = 8;

const QUERY_SYS = `You convert a candidate resume into job-search queries for New Zealand job sites.
Output up to 4 queries, ONE PER LINE. Each line is a job TITLE the candidate should search for
(2-4 lowercase words, no commas or punctuation), e.g.
senior software engineer
.net developer
integration developer
If unsure, output: software developer`;

/**
 * The query prompt, plus the kinds of role the user's title caps rule out — without that
 * line a resume full of (say) management work steers the model straight to them.
 */
function querySystem(caps: TitleCap[]): string {
  if (!caps.length) return QUERY_SYS;
  const words = caps.map((c) => `"${c.title}"`).join(", ");
  return `${QUERY_SYS}\nNever output a query containing ${words}, even if the resume describes that kind of work.`;
}

const KW_SYS = `Extract up to 10 of the most relevant, distinctive skill keywords or phrases from the resume.
Return ONLY a JSON array of lowercase strings, e.g. ["c#",".net","aws","fhir","integration"].`;

/**
 * Resume agent: load the master resume + profile, then derive the search queries
 * and keyword list the search/application agents need. Uses Claude when an API
 * key is set, otherwise a deterministic read of the profile's target roles.
 */
export async function resumeAgent(cfg: SearchConfig): Promise<ResumeContext> {
  const profile = await loadProfile();
  const caps = titleCapsFor(profile.preferences);
  const finalizeQueries = (raw: string[]): string[] => finalize(raw, caps);
  const resumeText = profile.resumeMaster || [profile.skills, profile.experience].join("\n\n");
  const keywordsFor = (queries: string[]): string[] =>
    heuristicKeywords(resumeText, profile.skills, queries);

  // job-search.md `primary_searches` wins — it is the explicit, user-owned list.
  if (cfg.primarySearches.length) {
    const queries = finalizeQueries(cfg.primarySearches);
    return ctx(resumeText, queries, keywordsFor(queries));
  }

  // Legacy single-query override.
  if (cfg.keywordsOverride.trim()) {
    const queries = finalizeQueries([cfg.keywordsOverride]);
    const kws = cfg.keywordsOverride.toLowerCase().split(/[\s,]+/).filter(Boolean);
    return ctx(resumeText, queries, kws);
  }

  if (!config.anthropicApiKey) {
    const queries = finalizeQueries(profileRoleQueries(profile.preferences, profile.resumeMaster));
    return ctx(resumeText, queries, keywordsFor(queries));
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const [asked, keywords] = await Promise.all([
    askText(client, querySystem(caps), resumeText).then(parseQueryLines),
    askText(client, KW_SYS, resumeText).then((t) => parseKeywords(t, resumeText, profile.skills)),
  ]);
  // Claude can return junk or nothing; the profile's own target roles are the safety net.
  const queries = finalizeQueries(
    asked.length ? asked : profileRoleQueries(profile.preferences, profile.resumeMaster),
  );
  return ctx(resumeText, queries, keywords);
}

function ctx(resumeText: string, searchQueries: string[], keywords: string[]): ResumeContext {
  return { resumeText, searchQuery: searchQueries[0] ?? FALLBACK_QUERY, searchQueries, keywords };
}

async function askText(client: Anthropic, system: string, resume: string): Promise<string> {
  const msg = await client.messages.create({
    model: config.scoringModel,
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: `Resume:\n${resume.slice(0, 8000)}` }],
  });
  const t = msg.content.find((c) => c.type === "text");
  return t && t.type === "text" ? t.text.trim() : "";
}

const parseQueryLines = (raw: string): string[] => raw.split("\n");

/**
 * Job-board queries match on the job TITLE, so a query has to look like one. Keep
 * `.` `#` `+` (".net", "c#", "c++") and drop everything else punctuation-wise.
 */
function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.#+\s]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(^|\s)[.#+]+(?=\s|$)/g, " ") // bare punctuation left by the strip
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

/**
 * Normalize, de-duplicate, drop junk, and bound the list. A query for a kind of role the
 * user's title caps hold down (see titleCaps.ts) is dropped too: searching for it would spend
 * the run pulling in exactly the listings that then get capped.
 */
function finalize(raw: string[], caps: TitleCap[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const q = normalizeQuery(r);
    // A single bare word ("engineer", "senior") matches half the board — too broad to be useful.
    if (!q || q.split(" ").length < 2 || isCappedQuery(q, caps) || out.includes(q)) continue;
    out.push(q);
  }
  return out.length ? out.slice(0, MAX_QUERIES) : [FALLBACK_QUERY];
}

/**
 * Deterministic query source: the "## Target roles" list in preferences.md — the one
 * place the user actually writes down what they want to be found for. Falls back to
 * the `role:` frontmatter on resume-master.md.
 *
 * Previously this position was filled by the most FREQUENT tokens in the resume, which
 * produced noun-soup of the resume's most common words — a query that matches
 * consultant listings and almost no developer roles.
 */
function profileRoleQueries(preferences: string, resumeMaster: string): string[] {
  const queries = targetRoleLines(preferences).flatMap(expandRoleLine);
  if (queries.length) return queries;

  const role = String(matter(resumeMaster || "").data.role ?? "");
  // "Senior Backend Developer - Payments & Data" → the title before the qualifier.
  const head = role.split(/[-–—|]/)[0] ?? "";
  return head.trim() ? [head] : [];
}

/** Bullet lines under a "## Target roles" heading in preferences.md. */
function targetRoleLines(preferences: string): string[] {
  // Lazy body, stopping at the next `## heading` or the true end of the string
  // (`$` alone would stop at the first newline under the `m` flag).
  const m = preferences.match(/^##+\s*target roles\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im);
  if (!m?.[1]) return [];
  return [...m[1].matchAll(/^\s*[-*]\s+(.+)$/gm)]
    .map((x) => (x[1] ?? "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
}

/** Head nouns a slash-alternative replaces at the END of a role title. */
const ROLE_NOUNS = new Set([
  "developer", "engineer", "specialist", "consultant", "programmer", "analyst", "architect",
]);

/**
 * Expand a slash-separated role line into the titles it stands for:
 *   "Senior Software Developer / Engineer" → senior software developer, senior software engineer
 *   "Backend / .NET Developer"             → .net developer, backend developer
 * A one-word alternative swaps the head noun when it is one ("engineer"), otherwise the
 * qualifier ("backend"). The longest segment is the template the others substitute into.
 */
function expandRoleLine(line: string): string[] {
  const parts = line.split("/").map((s) => normalizeQuery(s)).filter(Boolean);
  if (parts.length < 2) return [normalizeQuery(line)];

  const full = parts.reduce((a, b) => (b.split(" ").length > a.split(" ").length ? b : a));
  const template = full.split(" ");
  const out = [full];
  for (const p of parts) {
    if (p === full) continue;
    const words = p.split(" ");
    if (words.length > 1) {
      out.push(p);
      continue;
    }
    const next = [...template];
    if (ROLE_NOUNS.has(words[0]!)) next[next.length - 1] = words[0]!;
    else next[0] = words[0]!;
    out.push(next.join(" "));
  }
  return out;
}

function parseKeywords(raw: string, resumeText: string, skills: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return arr.map((x) => String(x).toLowerCase()).filter(Boolean).slice(0, 10);
    } catch {
      /* fall through */
    }
  }
  return heuristicKeywords(resumeText, skills);
}

/**
 * Cheap fallback: frequent multi-char tokens from the skills section + resume, led by
 * the words of the search queries so the tailoring/heuristic paths see the target role.
 */
function heuristicKeywords(resumeText: string, skills: string, queries: string[] = []): string[] {
  const source = `${skills}\n${resumeText}`.toLowerCase();
  const tokens = source.match(/[a-z][a-z0-9.#+/-]{2,}/g) ?? [];
  const stop = new Set(["and", "the", "with", "for", "across", "from", "into", "that", "this"]);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (stop.has(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const fromQueries = queries.flatMap((q) => q.split(" ")).filter((w) => w.length > 2);
  return [...new Set([...fromQueries, ...ranked])].slice(0, 10);
}
