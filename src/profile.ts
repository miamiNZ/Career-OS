import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { Profile } from "./types.js";

/**
 * The candidate description every scorer is judged against.
 *
 * Scoring used to be handed `skills.md` + `preferences.md` and nothing else, so the
 * approved master CV — the document the user actually sends, and the one they compare
 * the board against — was never seen by the scorer. Anything added to the resume but
 * not back-ported into skills.md (a new framework, a new tool) simply did not exist as far
 * as fit was concerned, which is exactly the "scores don't match my resume" gap. The digest makes resume-master.md the primary
 * source and keeps the profile notes as supporting detail.
 *
 * It is deterministic: same vault in, same string out. That matters because its hash
 * stamps every score, so a run can tell which notes were scored against an older you.
 */

/** Hard ceiling. The digest is re-sent on every job, so a runaway resume can't blow up the prompt. */
const MAX_DIGEST_CHARS = 6000;

/** Compare headings on their words alone, so "Hard filters (auto-reject…)" is matchable as typed. */
const normHeading = (s: string): string => s.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();

const isH2 = (line: string): boolean => /^##[^#]/.test(line);

/**
 * Body under a `## Heading`, up to the next `##`. Line-based rather than a regex: these
 * sections contain `###` sub-headings and blank lines, and a lazy multiline regex gets
 * those wrong in ways that silently return "".
 */
export function section(md: string, heading: string): string {
  const lines = md.split(/\r?\n/);
  const want = normHeading(heading);
  const start = lines.findIndex((l) => isH2(l) && normHeading(l.replace(/^#+/, "")) === want);
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !isH2(lines[i]!); i++) out.push(lines[i]!);
  return out.join("\n").trim();
}

/**
 * Bullet lines (`- foo`) under a heading, with markdown bold stripped. Wrapped bullets
 * are folded back into one line — preferences.md hard-wraps its longer entries, and
 * taking only the first physical line cut the deprioritise rule off mid-sentence.
 * `TODO:` placeholders are dropped: they are prompts to the user, not facts about them.
 */
function bullets(md: string, heading: string): string[] {
  const out: string[] = [];
  for (const line of section(md, heading).split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
    else if (out.length && line.trim() && !/^\s*#/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out
    .map((b) => b.replace(/\*\*/g, "").replace(/\s+/g, " ").trim())
    .filter((b) => b && !/^todo\b/i.test(b));
}

/** `### Role | Employer | dates` lines from the resume's Work Experience section. */
function roleHistory(resume: string): string[] {
  return [...section(resume, "Work Experience").matchAll(/^###\s+(.+)$/gm)]
    .map((m) => (m[1] ?? "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
}

const block = (title: string, body: string): string => (body.trim() ? `${title}:\n${body.trim()}` : "");
const list = (title: string, items: string[]): string =>
  block(title, items.map((i) => `- ${i}`).join("\n"));

/**
 * Build the canonical candidate profile text sent to the scorer (and to the heuristic
 * fallback's keyword extraction). Resume-master leads; the Profile notes fill the gaps.
 */
export function profileDigest(profile: Profile): string {
  const fm = matter(profile.resumeMaster || "").data as Record<string, unknown>;
  const resume = profile.resumeMaster || "";
  const prefs = profile.preferences || "";

  const identity = [
    fm.role ? `Current target title: ${String(fm.role)}` : "",
    fm.location ? `Based: ${String(fm.location)}` : "",
    fm.work_rights ? `Work rights: ${String(fm.work_rights)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const parts = [
    block("CANDIDATE", identity),
    block("PROFESSIONAL SUMMARY", section(resume, "Professional Summary")),
    // The resume's skills table is richer and more current than skills.md; keep the
    // profile note as a fallback so a vault without a master resume still scores.
    block("TECHNICAL SKILLS", section(resume, "Technical Skills") || profile.skills),
    list("CAREER HISTORY (most recent first)", roleHistory(resume).slice(0, 6)),
    list("TARGET ROLES", bullets(prefs, "Target roles")),
    list("ROLES TO SCORE LOW", bullets(prefs, "Roles to deprioritise (score these LOW)")),
    list("LOCATION & WORK MODE", bullets(prefs, "Location & work mode")),
    list("DOMAINS OF INTEREST", bullets(prefs, "Domains of interest")),
    list("HARD REQUIREMENTS", bullets(prefs, "Hard filters (auto-reject if missing/violated)")),
  ].filter(Boolean);

  // Nothing usable in the vault (fresh install, unreadable share) — fall back to the raw
  // notes rather than scoring every job against an empty candidate.
  const digest = parts.length
    ? parts.join("\n\n")
    : [profile.skills, profile.preferences].filter(Boolean).join("\n\n");

  return digest.length > MAX_DIGEST_CHARS ? `${digest.slice(0, MAX_DIGEST_CHARS)}\n…` : digest;
}

/**
 * Just the skill vocabulary, for the keyword-overlap fallback. The full digest is the
 * wrong input there: it carries prose and section labels, and the fallback's score is
 * "how many of these tokens does the ad mention", so every non-skill word it contains
 * inflates the number. Resume first, skills.md as the fallback — same precedence as the
 * digest itself.
 */
export function profileSkillsText(profile: Profile): string {
  return section(profile.resumeMaster || "", "Technical Skills") || profile.skills || "";
}

/**
 * Short stable hash of a digest, stamped onto every score. A note whose stamp differs
 * from the current profile was scored against a different resume, which is what makes
 * `rescore --stale` able to fix only the affected notes instead of the whole board.
 */
export function profileFingerprint(digest: string): string {
  return createHash("sha256").update(digest).digest("hex").slice(0, 12);
}
