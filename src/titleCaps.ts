import matter from "gray-matter";

/**
 * A ceiling on the fit score of jobs whose title names a kind of role the user doesn't
 * want, even when the CV is full of matching evidence. Read from the frontmatter of
 * Career/Profile/preferences.md:
 *
 *   title_fit_caps:
 *     - title: manager            # whole word, any case
 *       max_fit: 40               # fit never shown above this
 *       unless: [engineering]     # …unless the title also has one of these
 *
 * The same list keeps those titles out of the search queries, so a run doesn't spend its
 * search slots pulling in listings that will only be capped. With no list, nothing is capped.
 */
export interface TitleCap {
  title: string;
  maxFit: number;
  unless: string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive phrase match; spaces in the phrase match any whitespace. */
const wordRe = (phrase: string, suffix = ""): RegExp =>
  new RegExp(`\\b${escapeRe(phrase.trim()).replace(/\s+/g, "\\s+")}${suffix}\\b`, "i");

/** The caps configured in a preferences note. Malformed entries are skipped, not guessed at. */
export function titleCapsFor(preferences = ""): TitleCap[] {
  let raw: unknown;
  try {
    raw = (matter(preferences).data as Record<string, unknown>).title_fit_caps;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const caps: TitleCap[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const maxFit = Number(e.max_fit);
    if (!title || !Number.isFinite(maxFit) || maxFit < 0 || maxFit > 100) continue;
    const unless = (Array.isArray(e.unless) ? e.unless : typeof e.unless === "string" ? e.unless.split(",") : [])
      .map((u) => String(u).trim())
      .filter(Boolean);
    caps.push({ title, maxFit, unless });
  }
  return caps;
}

/** The tightest cap that applies to a job title, or undefined when none does. */
export function capForTitle(jobTitle: string, caps: TitleCap[]): TitleCap | undefined {
  const applies = caps.filter(
    (c) => wordRe(c.title, "s?").test(jobTitle) && !c.unless.some((u) => wordRe(u).test(jobTitle)),
  );
  return applies.sort((a, b) => a.maxFit - b.maxFit)[0];
}

/**
 * Whether a search query asks for a capped kind of role. Matches word forms too
 * ("manager" also catches "managers"), because any of them pulls
 * the capped listings back in.
 */
export function isCappedQuery(query: string, caps: TitleCap[]): boolean {
  return caps.some((c) => wordRe(c.title, "\\w*").test(query));
}
