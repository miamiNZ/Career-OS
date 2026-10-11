/**
 * Tests for src/agents/resume.ts — heuristicKeywords path (no API key).
 * Mocks Anthropic SDK and vault.loadProfile.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchConfig } from "../src/searchConfig.js";

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '["c#","dotnet","aws","integration"]' }],
      }),
    },
  })),
}));

// Inlined, not a module-level const: vi.mock is hoisted above every declaration.
vi.mock("../src/vault.js", () => ({
  loadProfile: vi.fn().mockResolvedValue({
    skills: "C# .NET AWS CQRS FHIR REST API RabbitMQ integration developer",
    experience: "Northwind Health Southern Fibre Harbour",
    education: "BSc",
    preferences: [
      "---",
      "title_fit_caps:",
      "  - title: manager",
      "    max_fit: 40",
      "    unless: [engineering]",
      "---",
      "# Job Preferences",
      "",
      "## Target roles",
      "- Senior Backend Developer / Engineer",
      "- Data Engineer / Analyst",
      "- Frontend / React Developer",
      "",
      "## Roles to deprioritise (score these LOW)",
      "- Manager-titled roles",
    ].join("\n"),
    resumeMaster: "---\nrole: Senior Backend Developer - Payments & Data\n---\n\n# John Smith\n\n## Skills\n\nC# .NET AWS",
    coverLetterTemplate: "Dear {{hiring_manager}},",
  }),
}));

import { resumeAgent } from "../src/agents/resume.js";

const makeSearchConfig = (overrides: Partial<SearchConfig> = {}): SearchConfig => ({
  location: "New Zealand",
  sites: ["seek"],
  maxResultsPerSite: 20,
  employmentType: "full-time",
  engagement: "permanent",
  keywordsOverride: "",
  tradeMeTitle: "Software Developer",
  minFitToApply: 70,
  primarySearches: [],
  extraSearches: [],
  extraLocations: [],
  ...overrides,
});

describe("resumeAgent — keywordsOverride path", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  it("uses the override directly when keywordsOverride is set", async () => {
    const cfg = makeSearchConfig({ keywordsOverride: "integration developer dotnet" });
    const result = await resumeAgent(cfg);
    expect(result.searchQuery).toBe("integration developer dotnet");
    expect(result.keywords).toContain("integration");
    expect(result.keywords).toContain("developer");
    expect(result.keywords).toContain("dotnet");
  });

  it("returns resumeText from profile", async () => {
    const cfg = makeSearchConfig({ keywordsOverride: "c# aws" });
    const result = await resumeAgent(cfg);
    expect(result.resumeText).toBeTruthy();
    expect(typeof result.resumeText).toBe("string");
  });
});

describe("resumeAgent — primarySearches path", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  it("uses primary_searches verbatim and outranks keywordsOverride", async () => {
    const cfg = makeSearchConfig({
      primarySearches: ["senior software engineer", ".net developer"],
      keywordsOverride: "integration developer dotnet",
    });
    const result = await resumeAgent(cfg);
    expect(result.searchQueries).toEqual(["senior software engineer", ".net developer"]);
    expect(result.searchQuery).toBe("senior software engineer");
  });

  it("drops capped-title queries and duplicates", async () => {
    const cfg = makeSearchConfig({
      primarySearches: ["Senior Software Engineer", "delivery manager", "senior software engineer"],
    });
    const result = await resumeAgent(cfg);
    expect(result.searchQueries).toEqual(["senior software engineer"]);
  });

  it("falls back to 'software developer' when every query is rejected", async () => {
    const cfg = makeSearchConfig({ primarySearches: ["project manager", "engineer"] });
    const result = await resumeAgent(cfg);
    expect(result.searchQueries).toEqual(["software developer"]);
  });

  it("keeps capped-title queries when the preferences set no title caps", async () => {
    const { loadProfile } = await import("../src/vault.js");
    const base = await loadProfile();
    vi.mocked(loadProfile).mockResolvedValueOnce({ ...base, preferences: "# Job Preferences" });
    const cfg = makeSearchConfig({ primarySearches: ["delivery manager", "senior software engineer"] });
    const result = await resumeAgent(cfg);
    expect(result.searchQueries).toEqual(["delivery manager", "senior software engineer"]);
  });
});

describe("resumeAgent — target-roles derivation (no API key)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  it("derives one query per target role, expanding slash alternatives", async () => {
    const result = await resumeAgent(makeSearchConfig());
    expect(result.searchQueries).toEqual([
      "senior backend developer",
      "senior backend engineer",
      "data engineer",
      "data analyst",
      "react developer",
      "frontend developer",
    ]);
  });

  it("never derives a keyword blob or a capped-title query", async () => {
    const result = await resumeAgent(makeSearchConfig());
    for (const q of result.searchQueries) {
      expect(q).not.toMatch(/manager/);
      expect(q.split(" ").length).toBeLessThanOrEqual(5);
    }
  });

  it("leads the keywords with the target-role words", async () => {
    const result = await resumeAgent(makeSearchConfig());
    expect(result.keywords.slice(0, 3)).toEqual(["senior", "backend", "developer"]);
  });

  it("falls back to the resume `role:` frontmatter when there are no target roles", async () => {
    const { loadProfile } = await import("../src/vault.js");
    vi.mocked(loadProfile).mockResolvedValueOnce({
      skills: "C# .NET",
      experience: "",
      education: "",
      preferences: "# Job Preferences\n\nNo target roles listed.",
      resumeMaster: "---\nrole: Senior Backend Developer - Payments & Data\n---\n\n# CV",
      coverLetterTemplate: "",
    });
    const result = await resumeAgent(makeSearchConfig());
    expect(result.searchQueries).toEqual(["senior backend developer"]);
  });
});

describe("resumeAgent — heuristic path (no API key)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  it("returns keywords array", async () => {
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    expect(Array.isArray(result.keywords)).toBe(true);
    expect(result.keywords.length).toBeGreaterThan(0);
  });

  it("returns at most 10 keywords", async () => {
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    expect(result.keywords.length).toBeLessThanOrEqual(10);
  });

  it("returns a searchQuery string", async () => {
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    expect(typeof result.searchQuery).toBe("string");
    expect(result.searchQuery.length).toBeGreaterThan(0);
  });

  it("falls back to 'software developer' when no keywords found", async () => {
    const { loadProfile } = await import("../src/vault.js");
    vi.mocked(loadProfile).mockResolvedValueOnce({
      skills: "",
      experience: "",
      education: "",
      preferences: "",
      resumeMaster: "",
      coverLetterTemplate: "",
    });
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    // Empty profile → no tokens → fallback
    expect(result.searchQuery).toBeTruthy();
  });

  it("keywords are all lowercase strings", async () => {
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    for (const kw of result.keywords) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("keywords exclude stop words (and, the, with)", async () => {
    const cfg = makeSearchConfig();
    const result = await resumeAgent(cfg);
    const stopWords = ["and", "the", "with", "for", "across"];
    for (const sw of stopWords) {
      expect(result.keywords).not.toContain(sw);
    }
  });
});
