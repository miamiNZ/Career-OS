import Anthropic from "@anthropic-ai/sdk";
import matter from "gray-matter";
import { config, hardFilters } from "./config.js";
import { ollamaChat, ollamaAvailable, OllamaUnavailableError, OLLAMA_SCORE_MODEL } from "./llm.js";
import { vlog } from "./logbus.js";
import { profileDigest, profileFingerprint, profileSkillsText } from "./profile.js";
import { capForTitle, titleCapsFor, type TitleCap } from "./titleCaps.js";
import type { HardFilters, Job, Profile, Score } from "./types.js";

/**
 * The user's hard filters, read from the frontmatter of preferences.md:
 *
 *   min_salary: 80000                     # or "80k"; 0 / absent = no salary floor
 *   reject_if_citizenship_required: true  # absent = false
 *
 * Personal thresholds belong in the vault, not in code, so they change without a release
 * and never ship in the repository. Anything missing or unreadable falls back to the
 * defaults in config.ts, which reject nothing.
 */
export function hardFiltersFor(profile?: Pick<Profile, "preferences">): HardFilters {
  let fm: Record<string, unknown> = {};
  try {
    fm = matter(profile?.preferences || "").data as Record<string, unknown>;
  } catch {
    // Malformed frontmatter: keep the defaults rather than fail the whole scoring run.
  }
  return {
    ...hardFilters,
    minSalary: parseSalary(fm.min_salary) ?? hardFilters.minSalary,
    rejectIfCitizenshipRequired:
      typeof fm.reject_if_citizenship_required === "boolean"
        ? fm.reject_if_citizenship_required
        : hardFilters.rejectIfCitizenshipRequired,
  };
}

/** 75000, "75000", "75,000", "$75k", "75K" → 75000. Anything else → undefined. */
function parseSalary(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== "string") return undefined;
  const m = v.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)(k)?$/i);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

/** Deterministic hard filters — run before AI scoring. Returns reject reasons. */
export function hardFilterReject(job: Job, filters: HardFilters = hardFilters): string[] {
  const reasons: string[] = [];

  // Salary floor. Only reject when we parsed a max under the floor (don't reject unknowns).
  if (filters.minSalary > 0 && job.salaryMax !== undefined && job.salaryMax < filters.minSalary) {
    reasons.push(`salary ${job.salaryText} below $${filters.minSalary / 1000}k floor`);
  }

  // Citizenship-only roles. A job that accepts "citizen OR permanent resident" is not
  // citizen-only — only reject when citizenship (or a security clearance that needs it)
  // is mandatory AND no residency/PR pathway is stated.
  if (filters.rejectIfCitizenshipRequired) {
    const d = `${job.title} ${job.description}`.toLowerCase();

    // Residents/PR explicitly welcome → not a citizen-only role.
    const prAccepted =
      /\bpermanent resident(s|cy)?\b/.test(d) ||
      /\bnz\s*pr\b/.test(d) ||
      /\bpr\s+or\s+citizen/.test(d) ||
      /\bciti[sz]en(ship)?\s+or\s+(permanent\s+)?resident/.test(d) ||
      /\bresident\s+or\s+citi[sz]en/.test(d) ||
      /\b(nz|new zealand)\s+residen(t|cy)\b/.test(d) ||
      /\bresidency\b/.test(d) ||
      /\bright to work\b/.test(d);

    // Citizenship is genuinely mandatory.
    const citizenshipRequired =
      /\b(nz|new zealand)\s+citizen(ship)?\b/.test(d) ||
      /\bmust be (a |an )?(nz |new zealand )?citizen\b/.test(d) ||
      /\bciti[sz]ens?\s+only\b/.test(d);

    // Security/government clearance — in NZ these are normally citizen-gated.
    const clearanceRequired = /\b(security|baseline|government)\s+clearance\b/.test(d);

    if ((citizenshipRequired || clearanceRequired) && !prAccepted) {
      reasons.push("requires NZ citizenship / security clearance (no PR pathway stated)");
    }
  }

  return reasons;
}

/**
 * Deterministic title bias applied after any scorer (Claude / Ollama / heuristic). A CV full
 * of evidence for a kind of role the user doesn't want (e.g. management work, when they want
 * hands-on development) makes those listings outscore the ones they do want; the user's
 * `title_fit_caps` in preferences.md hold them below the apply threshold while they still
 * appear on the board for manual review.
 */
function applyTitleBias(job: Job, caps: TitleCap[], score: Score): Score {
  const cap = capForTitle(job.title, caps);
  if (!cap || score.fit <= cap.maxFit) return score;
  vlog(`[score] "${cap.title}" title cap ${score.fit}→${cap.maxFit} "${job.title}"`);
  return {
    ...score,
    fit: cap.maxFit,
    rationale: `${score.rationale} [${cap.title}-titled role — capped at ${cap.maxFit} by preferences]`.trim(),
  };
}

/**
 * Claude scoring instructions. Deliberately candidate-neutral: what this candidate wants
 * (roles, domains, location) reaches the model through the profile digest's TARGET ROLES,
 * DOMAINS OF INTEREST and LOCATION & WORK MODE sections, which come from the vault.
 */
export const CLAUDE_SCORE_SYS = `You are a job-fit scorer for a candidate in New Zealand.
Score how well the JOB matches the CANDIDATE profile. Reply ONLY with minified JSON:
{"fit":0-100,"matchedSkills":[..],"missingSkills":[..],"rationale":"<=160 chars"}
Score against the CANDIDATE profile as written — its TECHNICAL SKILLS and PROFESSIONAL
SUMMARY come straight from the master CV, so a skill listed there counts as held.
Weight: core skills overlap, seniority, relevance to the candidate's TARGET ROLES and
DOMAINS OF INTEREST, and fit with their LOCATION & WORK MODE.`;

/** Which scorer will run, recorded on the score so a stale one is identifiable later. */
export function scorerId(): string {
  return config.anthropicApiKey ? config.scoringModel : OLLAMA_SCORE_MODEL;
}

/**
 * AI fit score via Claude (or local Ollama when there is no API key), falling back to a
 * keyword heuristic. Every path is judged against `profileDigest(profile)` — one
 * canonical candidate description led by the master CV — so the board's numbers and the
 * resume in the vault can't drift apart.
 */
export async function scoreJob(job: Job, profile: Profile): Promise<Score> {
  const digest = profileDigest(profile);
  const rejectReasons = hardFilterReject(job, hardFiltersFor(profile));
  const caps = titleCapsFor(profile.preferences);
  const base: Score = {
    jobId: job.id,
    fit: 0,
    rejected: rejectReasons.length > 0,
    rejectReasons,
    matchedSkills: [],
    missingSkills: [],
    rationale: "",
    profileHash: profileFingerprint(digest),
    scorer: scorerId(),
  };
  if (base.rejected) {
    base.rationale = `Auto-rejected: ${rejectReasons.join("; ")}`;
    vlog(`[score] hard-reject "${job.title}" — ${rejectReasons.join("; ")}`);
    return base;
  }

  // Preferred: local semantic scoring via Ollama (real fit, not token overlap).
  if (!config.anthropicApiKey) {
    try {
      const r = await ollamaScore(job, digest);
      vlog(`[score] ollama fit=${r.fit} "${job.title}"`);
      return applyTitleBias(job, caps, { ...base, ...r });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // Tell "the model returned junk for this one job" apart from "Ollama has gone away".
      // The first is a per-job blip the keyword heuristic can paper over. The second would
      // silently heuristic-score every remaining job in the run, filling the board with fit
      // numbers no model produced and burying leads under a threshold they never really
      // failed — so it stops the run instead.
      if (!(await ollamaAvailable())) {
        throw new OllamaUnavailableError(
          `Ollama stopped responding partway through scoring ("${job.title}": ${why}). ` +
            `The run has been stopped rather than fall back to keyword scoring for the rest ` +
            `of the jobs. Start the Ollama service and run the search again.`,
        );
      }
      vlog(`[score] ollama failed (${why}) → heuristic "${job.title}"`);
      return applyTitleBias(job, caps, { ...base, ...heuristic(job, profile), scorer: "heuristic" });
    }
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const msg = await client.messages.create({
    model: config.scoringModel,
    max_tokens: 400,
    system: CLAUDE_SCORE_SYS,
    messages: [
      {
        role: "user",
        content: `CANDIDATE PROFILE:\n${digest}\n\nJOB:\nTitle: ${job.title}\nCompany: ${job.company ?? ""}\nLocation: ${job.location ?? ""}\nSalary: ${job.salaryText ?? ""}\nDescription:\n${job.description.slice(0, 6000)}`,
      },
    ],
  });
  vlog(`[score] claude ${config.scoringModel} in=${msg.usage?.input_tokens ?? 0} out=${msg.usage?.output_tokens ?? 0} "${job.title}"`);
  const text = msg.content.find((c) => c.type === "text");
  try {
    const j = JSON.parse(text && text.type === "text" ? text.text : "{}");
    return applyTitleBias(job, caps, {
      ...base,
      fit: Number(j.fit) || 0,
      matchedSkills: j.matchedSkills ?? [],
      missingSkills: j.missingSkills ?? [],
      rationale: j.rationale ?? "",
    });
  } catch {
    return applyTitleBias(job, caps, { ...base, ...heuristic(job, profile), scorer: "heuristic" });
  }
}

export const SCORE_SYS = `You are a job-fit scorer for a candidate in New Zealand. Judge how well the JOB
matches the CANDIDATE profile (skills, seniority, domain, preferences). Be discerning: an
unrelated field (marketing, nursing, trades) scores low even if generic words overlap.
The profile's TECHNICAL SKILLS and PROFESSIONAL SUMMARY are taken verbatim from the
candidate's master CV: treat anything listed there as a skill they hold.
Reply ONLY with JSON: {"fit": <0-100 integer>, "matched": [up to 6 skills the job shares with
the candidate], "missing": [up to 6 important skills the job wants that the candidate lacks],
"why": "<=160 chars"}`;

/** Local semantic fit via Ollama. Throws on any failure so the caller can fall back. */
async function ollamaScore(job: Job, digest: string): Promise<Partial<Score>> {
  // The candidate block is byte-identical across every job in a run and leads the prompt,
  // so Ollama's KV cache reuses its prefix instead of re-evaluating it each time.
  const user = `CANDIDATE PROFILE:\n${digest}\n\nJOB:\nTitle: ${job.title}\nCompany: ${job.company ?? ""}\nLocation: ${job.location ?? ""}\nDescription:\n${(job.description || "").slice(0, 5000)}`;
  const raw = await ollamaChat(SCORE_SYS, user, {
    json: true,
    temperature: 0.1,
    maxTokens: 300,
    model: OLLAMA_SCORE_MODEL,
  });
  const j = JSON.parse(raw);
  const fit = Math.max(0, Math.min(100, Math.round(Number(j.fit))));
  if (!Number.isFinite(fit)) throw new Error("no fit");
  return {
    fit,
    matchedSkills: Array.isArray(j.matched) ? j.matched.map(String).slice(0, 6) : [],
    missingSkills: Array.isArray(j.missing) ? j.missing.map(String).slice(0, 6) : [],
    rationale: String(j.why ?? "").slice(0, 200),
  };
}

/**
 * Ceiling for the keyword-overlap fallback. It measures word overlap, not fit: the
 * denominator caps at 18, so any wordy ad naming 18 of the candidate's skill tokens
 * saturated at 100 and sat above every genuinely-scored role on the board — a
 * "Director, Revenue Operations" ad scored 100 this way. Scaling to a ceiling keeps the
 * ordering the overlap gives while stopping a guess from claiming a perfect match.
 */
const HEURISTIC_MAX_FIT = 60;

/**
 * Fallback fit: how much of the candidate's skill set the job actually mentions
 * (coverage), with a boost when key skills appear in the title. Coverage-based
 * so the number is meaningful, not an arbitrary count scaled to 100.
 */
function heuristic(job: Job, profile: Profile): Partial<Score> {
  const skills = Array.from(
    new Set(
      profileSkillsText(profile)
        .toLowerCase()
        .match(/[a-z][a-z0-9.#+/-]{1,}/g)
        ?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [],
    ),
  );
  const title = job.title.toLowerCase();
  const text = `${title} ${job.description}`.toLowerCase();
  const matched = skills.filter((s) => text.includes(s));
  const inTitle = matched.filter((s) => title.includes(s));

  const denom = Math.max(6, Math.min(skills.length, 18));
  const coverage = matched.length / denom;
  const fit = Math.round(Math.min(1, coverage + (inTitle.length ? 0.15 : 0)) * HEURISTIC_MAX_FIT);

  const missing = skills.filter((s) => !text.includes(s)).slice(0, 8);
  return {
    fit,
    matchedSkills: matched.slice(0, 12),
    missingSkills: missing,
    rationale: `Keyword match only (no scorer available) — matched ${matched.length} of your key skills${inTitle.length ? " (some in the title)" : ""}: ${matched.slice(0, 6).join(", ") || "none"}.`,
  };
}

const STOP = new Set([
  "and", "the", "with", "for", "from", "you", "your", "are", "our", "have",
  "will", "work", "team", "role", "experience", "skills", "using", "etc",
]);
