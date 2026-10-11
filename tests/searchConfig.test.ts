/**
 * Tests for src/searchConfig.ts — loadSearchConfig parses frontmatter and falls back to defaults.
 * Uses real temp-dir filesystem writes instead of mocking fs.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We must set VAULT_PATH before config.ts is imported transitively.
// vitest.config.ts sets it in `env`, so we can import directly.
import { loadSearchConfig } from "../src/searchConfig.js";
import { titleMatches } from "../src/orchestrator.js";

let tmpDir: string;
let profileDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "career-os-searchcfg-"));
  profileDir = path.join(tmpDir, "Career", "Profile");
  await fs.mkdir(profileDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSearchMd(frontmatter: Record<string, unknown>): Promise<void> {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "");
  await fs.writeFile(path.join(profileDir, "job-search.md"), lines.join("\n"), "utf8");
}

async function removeSearchMd(): Promise<void> {
  try {
    await fs.rm(path.join(profileDir, "job-search.md"), { force: true });
  } catch {
    // ok if not present
  }
}

describe("loadSearchConfig — unreachable vault", () => {
  it("throws rather than silently searching nationwide with no tracks", async () => {
    // A directory where job-search.md should be is what an unreachable SMB share looks
    // like to fs.readFile: not ENOENT, so it must not be mistaken for "not configured".
    const pDir = path.join(process.env["VAULT_PATH"]!, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const asDir = path.join(pDir, "job-search.md");
    await fs.rm(asDir, { recursive: true, force: true });
    await fs.mkdir(asDir, { recursive: true });
    try {
      await expect(loadSearchConfig()).rejects.toThrow(/vault is unreachable/);
    } finally {
      await fs.rm(asDir, { recursive: true, force: true });
    }
  });
});

describe("loadSearchConfig — defaults when file absent", () => {
  it("falls back to defaults when job-search.md is missing", async () => {
    // Point vault at a directory with NO job-search.md
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "career-os-empty-"));
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.location).toBe("New Zealand");
      expect(cfg.sites).toContain("seek");
      expect(cfg.maxResultsPerSite).toBe(20);
      expect(cfg.minFitToApply).toBe(70);
      expect(cfg.extraSearches).toEqual([]);
      expect(cfg.extraLocations).toEqual([]);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// NOTE: loadSearchConfig reads from vault.profileDir which is derived from VAULT_PATH env
// set at process startup. The VAULT_PATH=/tmp/career-os-test-vault set in vitest.config.ts
// doesn't have a job-search.md, so the default-fallback tests above cover that path.
// The remaining tests write into a separate tmpDir and call loadSearchConfig indirectly
// by temporarily swapping vault.profileDir — but since vault is a const, we test
// the parsing logic by checking what values loadSearchConfig returns from what it finds.

describe("parseStringList — via extraSearches / extraLocations", () => {
  // These tests verify the parser handles YAML arrays vs comma strings
  // by writing real files to the vault profileDir and calling loadSearchConfig.
  // Since vault.profileDir is fixed at startup, we write there directly.

  it("parses extra_searches as a YAML list", async () => {
    // We can't easily override vault.profileDir, so we test indirectly.
    // Instead, directly test the internal parsing by exercising the exported function
    // with a config file written to the actual vault profileDir.

    // The vault profileDir is /tmp/career-os-test-vault/Career/Profile
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    const content = [
      "---",
      "extra_searches:",
      "  - courier driver",
      "  - delivery driver",
      "extra_location:",
      "  - Waikato",
      "  - Otago",
      "---",
      "",
    ].join("\n");
    await fs.writeFile(file, content, "utf8");
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.extraSearches).toEqual(["courier driver", "delivery driver"]);
      expect(cfg.extraLocations).toEqual(["Waikato", "Otago"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("parses extra_searches as a comma-separated string", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      '---\nextra_searches: "courier,delivery driver,van driver"\n---\n',
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.extraSearches).toEqual(["courier", "delivery driver", "van driver"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("parses sites as a YAML list, dropping unknown values", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nsites:\n  - seek\n  - trademe\n  - invalid-site\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.sites).toEqual(["seek", "trademe"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("accepts indeed as a site and still accepts zeil", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(file, "---\nsites: [seek, indeed, zeil]\n---\n", "utf8");
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.sites).toEqual(["seek", "indeed", "zeil"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("uses defaults for sites when list is empty after filtering", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nsites:\n  - not-a-site\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.sites).toContain("seek"); // defaults
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("reads numeric fields", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nmax_results_per_site: 50\nmin_fit_to_apply: 80\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.maxResultsPerSite).toBe(50);
      expect(cfg.minFitToApply).toBe(80);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("reads min_fit_to_keep, and defaults it OFF when absent", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(file, "---\nmin_fit_to_keep: 20\n---\n", "utf8");
    try {
      expect((await loadSearchConfig()).minFitToKeep).toBe(20);
      // Absent => 0, so auto-dropping never turns itself on.
      await fs.writeFile(file, "---\nlocation: New Zealand\n---\n", "utf8");
      expect((await loadSearchConfig()).minFitToKeep).toBe(0);
      // An explicit 0 must survive — `|| default` would silently re-enable it.
      await fs.writeFile(file, "---\nmin_fit_to_keep: 0\n---\n", "utf8");
      expect((await loadSearchConfig()).minFitToKeep).toBe(0);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("parses primary_searches as a YAML list", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nprimary_searches:\n  - senior software engineer\n  - .net developer\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.primarySearches).toEqual(["senior software engineer", ".net developer"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("leaves primarySearches empty when the key is absent or an empty list", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(file, "---\nprimary_searches: []\nlocation: New Zealand\n---\n", "utf8");
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.primarySearches).toEqual([]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("reads location and trademe_title", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nlocation: Hamilton\ntrademe_title: Integration Developer\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.location).toBe("Hamilton");
      expect(cfg.tradeMeTitle).toBe("Integration Developer");
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});

describe("search_tracks — named extra tracks", () => {
  const vaultBase = process.env["VAULT_PATH"]!;
  const pDir = path.join(vaultBase, "Career", "Profile");
  const file = path.join(pDir, "job-search.md");

  const write = async (frontmatter: string): Promise<void> => {
    await fs.mkdir(pDir, { recursive: true });
    await fs.writeFile(file, `---\n${frontmatter}\n---\n`, "utf8");
  };

  afterEach(async () => {
    await fs.rm(file, { force: true });
  });

  it("parses each declared track with its own searches and locations", async () => {
    await write(
      [
        "search_tracks:",
        "  - name: courier",
        "    searches:",
        "      - courier",
        "      - delivery driver",
        "    location:",
        "      - Waikato",
        "      - Hamilton",
        "  - name: local-it",
        "    searches:",
        "      - it support",
        "    location:",
        "      - Waikato",
      ].join("\n"),
    );
    const cfg = await loadSearchConfig();
    expect(cfg.tracks).toEqual([
      {
        name: "courier",
        searches: ["courier", "delivery driver"],
        locations: ["Waikato", "Hamilton"],
        titleMatch: [],
        seekClassifications: [],
        tradeMeCategories: [],
      },
      {
        name: "local-it",
        searches: ["it support"],
        locations: ["Waikato"],
        titleMatch: [],
        seekClassifications: [],
        tradeMeCategories: [],
      },
    ]);
  });

  it("resolves category aliases and keeps a browse-only track", async () => {
    await write(
      [
        "search_tracks:",
        "  - name: local-it",
        "    seek_classification: [ict]",
        "    trademe_category: IT",
        "    location: [Waikato]",
      ].join("\n"),
    );
    const cfg = await loadSearchConfig();
    expect(cfg.tracks).toEqual([
      {
        name: "local-it",
        searches: [],
        locations: ["Waikato"],
        titleMatch: [],
        seekClassifications: ["6281"],
        tradeMeCategories: ["5000-5112-"],
      },
    ]);
  });

  it("passes an unrecognised classification id straight through", async () => {
    await write(
      ["search_tracks:", "  - name: x", "    seek_classification: [1209, 6281]"].join("\n"),
    );
    const cfg = await loadSearchConfig();
    expect(cfg.tracks[0]?.seekClassifications).toEqual(["1209", "6281"]);
  });

  it("keeps the legacy extra_searches pair working as the first track", async () => {
    await write(["extra_searches:", "  - courier", "extra_location:", "  - Waikato"].join("\n"));
    const cfg = await loadSearchConfig();
    expect(cfg.tracks).toEqual([
      {
        name: "extra",
        searches: ["courier"],
        locations: ["Waikato"],
        titleMatch: [],
        seekClassifications: [],
        tradeMeCategories: [],
      },
    ]);
  });

  it("runs the legacy pair before any declared track", async () => {
    await write(
      [
        "extra_searches:",
        "  - courier",
        "search_tracks:",
        "  - name: local-it",
        "    searches:",
        "      - it support",
      ].join("\n"),
    );
    const cfg = await loadSearchConfig();
    expect(cfg.tracks.map((t) => t.name)).toEqual(["extra", "local-it"]);
    // No location on the declared track means nationwide, not "inherit the legacy one".
    expect(cfg.tracks[1]!.locations).toEqual([]);
  });

  it("accepts `locations` as well as `location`", async () => {
    await write(
      ["search_tracks:", "  - name: t", "    searches: [it support]", "    locations: [Otago]"].join("\n"),
    );
    const cfg = await loadSearchConfig();
    expect(cfg.tracks[0]!.locations).toEqual(["Otago"]);
  });

  it("drops a track with no searches rather than running it empty", async () => {
    await write(["search_tracks:", "  - name: empty", "    location: [Waikato]"].join("\n"));
    const cfg = await loadSearchConfig();
    expect(cfg.tracks).toEqual([]);
  });

  it("names an unnamed track by position", async () => {
    await write(["search_tracks:", "  - searches: [it support]"].join("\n"));
    const cfg = await loadSearchConfig();
    expect(cfg.tracks[0]!.name).toBe("track-1");
  });

  it("has no tracks when nothing is configured", async () => {
    await write("location: New Zealand");
    const cfg = await loadSearchConfig();
    expect(cfg.tracks).toEqual([]);
  });
});

describe("titleMatches — a track's title filter", () => {
  const IT = ["it", "software", "developer", "help desk", "data", "digital"];

  it("keeps everything when no terms are configured", () => {
    expect(titleMatches("Office Administrator", [])).toBe(true);
  });

  it("matches a term as a whole word, ignoring case and punctuation", () => {
    expect(titleMatches("Operations & IT Support Co-ordinator", IT)).toBe(true);
    expect(titleMatches("IT/Systems Support", IT)).toBe(true);
    expect(titleMatches("Help-Desk Analyst", IT)).toBe(true);
  });

  it("does not match a term inside a longer word", () => {
    // The whole point of "it" being whole-word: these are not IT roles.
    expect(titleMatches("Unit Manager", IT)).toBe(false);
    expect(titleMatches("Recruitment Consultant", IT)).toBe(false);
  });

  it("cuts the local ads a body-text keyword search drags in", () => {
    expect(titleMatches("Office Administrator", IT)).toBe(false);
    expect(titleMatches("Customer Experience Specialist", IT)).toBe(false);
    expect(titleMatches("Programme Operation Manager", IT)).toBe(false);
  });

  it("keeps the real IT titles from the same result set", () => {
    expect(titleMatches("Data & Optimisation Engineer", IT)).toBe(true);
    expect(titleMatches("Digital Technology Manager", IT)).toBe(true);
    expect(titleMatches("Software Developer", IT)).toBe(true);
  });

  it("parses title_match off a track", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(
      file,
      "---\nsearch_tracks:\n  - name: t\n    searches: [it support]\n    title_match: [it, software]\n---\n",
      "utf8",
    );
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.tracks[0]!.titleMatch).toEqual(["it", "software"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("defaults title_match to empty — an existing track keeps every result", async () => {
    const vaultBase = process.env["VAULT_PATH"]!;
    const pDir = path.join(vaultBase, "Career", "Profile");
    await fs.mkdir(pDir, { recursive: true });
    const file = path.join(pDir, "job-search.md");
    await fs.writeFile(file, "---\nextra_searches: [courier]\n---\n", "utf8");
    try {
      const cfg = await loadSearchConfig();
      expect(cfg.tracks[0]!.titleMatch).toEqual([]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
