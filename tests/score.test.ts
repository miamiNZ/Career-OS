/**
 * Tests for src/score.ts — hardFilterReject and heuristic scoring.
 * Mocks Anthropic SDK and ollamaChat so no network calls happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job, Profile } from "../src/types.js";

// Mock Anthropic before importing score.ts (which imports it at module level)
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"fit":75,"matchedSkills":["c#"],"missingSkills":[],"rationale":"good match"}' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    })),
  };
});

// OLLAMA_SCORE_MODEL has to be part of the mock: score.ts reads it to stamp which scorer
// produced a number, outside the try/catch that swallows a failed ollamaChat. Without it
// the "ollama offline" tests below were reaching the heuristic via a missing-export
// ReferenceError rather than via the fallback path they claim to exercise.
// `ollamaAvailable` stays TRUE here on purpose. These cases exercise the heuristic
// fallback, which now only applies when the service is up and a single call came back
// unusable. A genuinely unreachable Ollama is a different path — it aborts the run rather
// than keyword-score the rest of the jobs — and has its own case at the bottom of the file.
// `importOriginal` keeps the real OllamaUnavailableError so `instanceof` still means
// something to the code under test.
vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return {
    ...actual,
    ollamaChat: vi.fn().mockRejectedValue(new Error("ollama returned junk")),
    ollamaAvailable: vi.fn().mockResolvedValue(true),
    OLLAMA_SCORE_MODEL: "test-model",
    OLLAMA_MODEL: "test-model",
    OLLAMA_URL: "http://localhost:11434",
  };
});

// config.ts reads env at import; VAULT_PATH is set in vitest.config.ts env.
import { CLAUDE_SCORE_SYS, SCORE_SYS, hardFilterReject, hardFiltersFor, scoreJob } from "../src/score.js";
import { profileDigest } from "../src/profile.js";
import { ollamaAvailable, ollamaChat, OllamaUnavailableError } from "../src/llm.js";

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  source: "seek",
  title: "Senior Software Developer",
  company: "Acme Ltd",
  location: "Wellington, NZ",
  url: "https://seek.co.nz/job/1",
  description: "We need a senior .NET developer with AWS and C# experience.",
  salaryText: "$120k - $140k",
  salaryMin: 120_000,
  salaryMax: 140_000,
  engagement: "permanent",
  employmentType: "full-time",
  workArrangement: "hybrid",
  ingestedAt: new Date().toISOString(),
  ...overrides,
});

/** A user's preferences note: the hard filters live in its frontmatter. */
const PREFERENCES = "---\nmin_salary: 75k\nreject_if_citizenship_required: false\n---\n\nPermanent, Wellington or remote.";

const makeProfile = (skills = ""): Profile => ({
  skills: skills || "C# .NET AWS REST API integration",
  experience: "Senior developer 15 years .NET AWS FHIR",
  education: "BSc Computer Science",
  preferences: PREFERENCES,
  resumeMaster: "",
  coverLetterTemplate: "",
});

describe("hardFiltersFor", () => {
  const prefs = (fm: string) => ({ preferences: `---\n${fm}\n---\n\nNotes.` });

  it("reads the floor and the citizenship switch from the preferences frontmatter", () => {
    expect(hardFiltersFor(prefs("min_salary: 75000\nreject_if_citizenship_required: true"))).toMatchObject({
      minSalary: 75_000,
      rejectIfCitizenshipRequired: true,
    });
  });

  it("accepts the floor written as 75k, $75,000 or a quoted number", () => {
    for (const v of ["75k", "75K", '"$75,000"', '"75000"']) {
      expect(hardFiltersFor(prefs(`min_salary: ${v}`)).minSalary).toBe(75_000);
    }
  });

  it("rejects nothing when the vault sets no filters", () => {
    expect(hardFiltersFor({ preferences: "Just prose, no frontmatter." })).toMatchObject({
      minSalary: 0,
      rejectIfCitizenshipRequired: false,
    });
    expect(hardFiltersFor(undefined).minSalary).toBe(0);
  });

  it("ignores a value it cannot read rather than guessing", () => {
    const f = hardFiltersFor(prefs("min_salary: lots\nreject_if_citizenship_required: maybe"));
    expect(f.minSalary).toBe(0);
    expect(f.rejectIfCitizenshipRequired).toBe(false);
  });
});

describe("hardFilterReject", () => {
  const filters = hardFiltersFor({ preferences: PREFERENCES });

  it("returns [] for a normal job", () => {
    expect(hardFilterReject(makeJob(), filters)).toEqual([]);
  });

  it("rejects when salaryMax is below the configured floor", () => {
    const reasons = hardFilterReject(makeJob({ salaryMax: 70_000, salaryText: "$60k - $70k" }), filters);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/salary.*below.*75k/i);
  });

  it("does NOT reject when salaryMax equals the floor", () => {
    expect(hardFilterReject(makeJob({ salaryMax: 75_000 }), filters)).toEqual([]);
  });

  it("does NOT reject when salaryMax is undefined (unknown salary)", () => {
    const job = makeJob({ salaryMax: undefined, salaryText: "Negotiable" });
    expect(hardFilterReject(job, filters)).toEqual([]);
  });

  it("applies no salary floor at all with the defaults", () => {
    expect(hardFilterReject(makeJob({ salaryMax: 10_000, salaryText: "$10k" }))).toEqual([]);
  });

  it("does NOT reject on citizenship when the switch is off", () => {
    const job = makeJob({
      title: "NZ Citizens Only — Senior Dev",
      description: "Must be NZ citizen. Security clearance required.",
    });
    expect(hardFilterReject(job, filters)).toEqual([]);
  });

  it("rejects a citizen-only role when the switch is on, but not one open to residents", () => {
    const strict = { ...filters, rejectIfCitizenshipRequired: true };
    const citizenOnly = makeJob({ description: "Must be a NZ citizen." });
    const residentsOk = makeJob({ description: "Must be a NZ citizen or permanent resident." });
    expect(hardFilterReject(citizenOnly, strict)).toHaveLength(1);
    expect(hardFilterReject(residentsOk, strict)).toEqual([]);
  });
});

describe("scoreJob — hard reject path", () => {
  it("returns rejected=true and fit=0 when salary is too low", async () => {
    const job = makeJob({ salaryMax: 60_000, salaryText: "$60k" });
    const score = await scoreJob(job, makeProfile());
    expect(score.rejected).toBe(true);
    expect(score.fit).toBe(0);
    expect(score.rejectReasons.length).toBeGreaterThan(0);
  });
});

describe("scoreJob — heuristic fallback (no API key, ollama offline)", () => {
  beforeEach(() => {
    // Ensure anthropicApiKey is empty so we go through heuristic path
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  it("returns a positive fit score when skills match", async () => {
    const job = makeJob({
      description: "Looking for C# .NET developer with AWS and REST API experience.",
    });
    const profile = makeProfile("c# dotnet aws rest api integration");
    const score = await scoreJob(job, profile);
    expect(score.rejected).toBe(false);
    expect(score.fit).toBeGreaterThan(0);
    expect(score.fit).toBeLessThanOrEqual(100);
  });

  it("includes matchedSkills and missingSkills", async () => {
    const job = makeJob({ description: "Need C# expert, knows Python and Kubernetes." });
    const profile = makeProfile("c# dotnet aws rest");
    const score = await scoreJob(job, profile);
    expect(Array.isArray(score.matchedSkills)).toBe(true);
    expect(Array.isArray(score.missingSkills)).toBe(true);
  });

  it("returns lower fit for an unrelated job", async () => {
    const job = makeJob({
      title: "Head Chef",
      description: "Managing kitchen operations, menu planning, food safety compliance.",
    });
    const profile = makeProfile("c# dotnet aws cqrs fhir integration");
    const score = await scoreJob(job, profile);
    // Heuristic: few/no skill tokens overlap
    expect(score.fit).toBeLessThan(50);
  });

  it("has a rationale string", async () => {
    const score = await scoreJob(makeJob(), makeProfile());
    expect(typeof score.rationale).toBe("string");
    expect(score.rationale.length).toBeGreaterThan(0);
  });

  it("boosts fit when skills appear in title", async () => {
    const withTitle = makeJob({ title: "C# AWS Integration Developer" });
    const withoutTitle = makeJob({ title: "Software Developer" });
    const profile = makeProfile("c# aws integration rest dotnet");

    const scoreWith = await scoreJob(withTitle, profile);
    const scoreWithout = await scoreJob(withoutTitle, profile);
    // Title match gives a +15 point boost
    expect(scoreWith.fit).toBeGreaterThanOrEqual(scoreWithout.fit);
  });

  it("caps fit at 100", async () => {
    const job = makeJob({ description: "c# dotnet aws rest integration fhir cqrs rabbitmq msmq cicd" });
    const profile = makeProfile("c# dotnet aws rest integration fhir cqrs rabbitmq msmq cicd");
    const score = await scoreJob(job, profile);
    expect(score.fit).toBeLessThanOrEqual(100);
  });

  it("never claims a perfect match, even on total keyword overlap", async () => {
    // Total overlap used to saturate the coverage ratio at 1.0 → fit 100, putting a
    // keyword guess above every genuinely-scored role on the board.
    const skills = "c# dotnet aws rest integration fhir cqrs rabbitmq msmq cicd sql azure docker";
    const score = await scoreJob(
      makeJob({ title: `${skills} developer`, description: skills }),
      makeProfile(skills),
    );
    expect(score.fit).toBeLessThanOrEqual(60);
    expect(score.fit).toBeGreaterThan(0);
  });

  it("labels itself as keyword-only so a guess is not mistaken for a real score", async () => {
    const score = await scoreJob(makeJob(), makeProfile("c# aws"));
    expect(score.rationale).toMatch(/keyword match only/i);
  });
});

describe("scoreJob — profile stamp", () => {
  it("records which profile and which scorer produced the number", async () => {
    const score = await scoreJob(makeJob(), makeProfile());
    expect(score.profileHash).toMatch(/^[0-9a-f]{12}$/);
    // Ollama is mocked as offline here, so the keyword fallback is what ran.
    expect(score.scorer).toBe("heuristic");
  });

  it("stamps hard-rejected jobs too, so a rejection is re-checkable after a CV edit", async () => {
    const score = await scoreJob(makeJob({ salaryMax: 40_000, salaryText: "$40k" }), makeProfile());
    expect(score.rejected).toBe(true);
    expect(score.profileHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("gives two different resumes two different stamps", async () => {
    const a = await scoreJob(makeJob(), makeProfile());
    const b = await scoreJob(makeJob(), {
      ...makeProfile(),
      resumeMaster: "# CV\n\n## Technical Skills\n\n- Rust, Go",
    });
    expect(b.profileHash).not.toBe(a.profileHash);
  });

  it("scores against the master CV, not just skills.md", async () => {
    // Playwright is on the CV only. The keyword fallback derives its vocabulary from the
    // same source the AI scorers are given, so it must be able to match on it.
    const score = await scoreJob(
      makeJob({ title: "Test Automation Developer", description: "Playwright and TypeScript." }),
      {
        ...makeProfile("cobol fortran"),
        resumeMaster: "# CV\n\n## Technical Skills\n\n- Playwright, TypeScript\n",
      },
    );
    expect(score.matchedSkills).toContain("playwright");
  });
});

describe("scoring instructions", () => {
  it("name no candidate-specific skills or domains — those come from the vault", () => {
    for (const prompt of [CLAUDE_SCORE_SYS, SCORE_SYS]) {
      expect(prompt).not.toMatch(/\.net|aws|healthcare|integration|fhir|senior software engineer/i);
    }
  });

  it("point Claude at digest sections the profile actually produces", () => {
    const digest = profileDigest({
      ...makeProfile(),
      preferences: [
        "## Target roles",
        "- Backend Developer",
        "## Domains of interest",
        "- Logistics",
        "## Location & work mode",
        "- Remote",
      ].join("\n"),
    });
    for (const section of ["TARGET ROLES", "DOMAINS OF INTEREST", "LOCATION & WORK MODE"]) {
      expect(CLAUDE_SCORE_SYS).toContain(section);
      expect(digest).toContain(`${section}:`);
    }
  });
});

describe("scoreJob — title fit caps from preferences", () => {
  const CAPPED = {
    ...makeProfile(),
    preferences: "---\ntitle_fit_caps:\n  - title: manager\n    max_fit: 40\n    unless: [engineering]\n---\n",
  };
  const strongFit = () =>
    vi.mocked(ollamaChat).mockResolvedValueOnce(
      '{"fit":90,"matchedSkills":["c#"],"missingSkills":[],"rationale":"strong"}',
    );

  it("holds a capped title at the configured ceiling", async () => {
    strongFit();
    const score = await scoreJob(makeJob({ title: "Delivery Manager" }), CAPPED);
    expect(score.fit).toBe(40);
    expect(score.rationale).toMatch(/capped at 40 by preferences/);
  });

  it("leaves a hands-on title alone", async () => {
    strongFit();
    const score = await scoreJob(makeJob({ title: "Engineering Manager" }), CAPPED);
    expect(score.fit).toBe(90);
  });

  it("caps nothing when the preferences set no caps", async () => {
    strongFit();
    const score = await scoreJob(makeJob({ title: "Delivery Manager" }), makeProfile());
    expect(score.fit).toBe(90);
  });
});

describe("scoreJob — Ollama unreachable", () => {
  afterEach(() => {
    vi.mocked(ollamaAvailable).mockResolvedValue(true);
  });

  it("aborts instead of keyword-scoring the rest of the run", async () => {
    vi.mocked(ollamaAvailable).mockResolvedValue(false);
    await expect(scoreJob(makeJob(), makeProfile())).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    );
  });

  it("names the service and what to do about it", async () => {
    vi.mocked(ollamaAvailable).mockResolvedValue(false);
    await expect(scoreJob(makeJob(), makeProfile())).rejects.toThrow(/Start the Ollama service/);
  });

  it("still falls back to the heuristic when the service is up", async () => {
    vi.mocked(ollamaAvailable).mockResolvedValue(true);
    const score = await scoreJob(makeJob(), makeProfile());
    expect(score.scorer).toBe("heuristic");
  });
});
