/**
 * Tests for src/profile.ts — the candidate digest every scorer is judged against.
 *
 * The behaviour that matters here is that resume-master.md actually reaches the scorer:
 * scoring used to see only skills.md + preferences.md, so anything on the approved CV but
 * not back-ported into skills.md was invisible to the fit number.
 */
import { describe, it, expect } from "vitest";
import { profileDigest, profileFingerprint, profileSkillsText } from "../src/profile.js";
import type { Profile } from "../src/types.js";

const RESUME = `---
role: Senior Backend Developer - Payments & Data
location: Nelson, Tasman, New Zealand
work_rights: Full right to work in New Zealand
---
# Jane Smith

## Professional Summary

Backend developer building payment and data services.

## Technical Skills

- **Languages:** C#, .NET 10, TypeScript
- **Testing:** Vitest, Playwright browser automation

## Work Experience

### Freelance Developer | 2024 to present

- Built a booking platform.

### Backend Developer - Northwind Health | 2020 to 2024

- Designed an event-sourced ledger on AWS.

## Education

BSc.
`;

const PREFS = `---
type: profile
---
# Job Preferences

## Target roles
- Senior Backend Developer / Engineer
- Data Engineer / Analyst

## Roles to deprioritise (score these LOW)
- **Manager-titled roles** (Engineering Manager, Delivery Manager) — I want
  hands-on engineering work, not people management.

## Location & work mode
- Based: Nelson, Tasman, New Zealand
- **Open to remote**

## Domains of interest
- Logistics / supply chain

## Hard filters (auto-reject if missing/violated)
- Minimum salary: **NZD $75k/year**
- TODO: preferred commute time
`;

const makeProfile = (overrides: Partial<Profile> = {}): Profile => ({
  skills: "## Core strengths\n- Payments systems\n- Older skills note",
  experience: "",
  education: "",
  preferences: PREFS,
  resumeMaster: RESUME,
  coverLetterTemplate: "",
  ...overrides,
});

describe("profileDigest", () => {
  it("carries the master CV's summary and skills, not just skills.md", () => {
    const d = profileDigest(makeProfile());
    expect(d).toContain("Backend developer building payment and data services.");
    expect(d).toContain("Playwright browser automation");
    // skills.md is the fallback, so it must not appear when the resume has the section.
    expect(d).not.toContain("Older skills note");
  });

  it("includes the resume's identity frontmatter", () => {
    const d = profileDigest(makeProfile());
    expect(d).toContain("Senior Backend Developer - Payments & Data");
    expect(d).toContain("Nelson, Tasman, New Zealand");
    expect(d).toContain("Full right to work in New Zealand");
  });

  it("lists the career history from the resume's role headings", () => {
    const d = profileDigest(makeProfile());
    expect(d).toContain("- Freelance Developer | 2024 to present");
    expect(d).toContain("- Backend Developer - Northwind Health | 2020 to 2024");
    // A `###` heading must not end the Work Experience section early.
    expect(d).not.toContain("BSc.");
  });

  it("carries the preferences the scorer has to honour", () => {
    const d = profileDigest(makeProfile());
    expect(d).toContain("Senior Backend Developer / Engineer");
    expect(d).toContain("Logistics / supply chain");
    expect(d).toContain("Minimum salary: NZD $75k/year");
  });

  it("folds a wrapped bullet back into one line", () => {
    const d = profileDigest(makeProfile());
    expect(d).toContain(
      "Manager-titled roles (Engineering Manager, Delivery Manager) — I want hands-on engineering work, not people management.",
    );
  });

  it("drops TODO placeholders — they describe the vault, not the candidate", () => {
    expect(profileDigest(makeProfile())).not.toContain("TODO");
  });

  it("falls back to skills.md when there is no master resume", () => {
    const d = profileDigest(makeProfile({ resumeMaster: "" }));
    expect(d).toContain("Older skills note");
  });

  it("still produces something usable when the vault is empty", () => {
    const d = profileDigest(makeProfile({ resumeMaster: "", preferences: "", skills: "C# .NET" }));
    expect(d).toContain("C# .NET");
  });

  it("is capped so a long resume cannot blow up every scoring prompt", () => {
    const huge = RESUME.replace("BSc.", "x".repeat(50_000));
    expect(profileDigest(makeProfile({ resumeMaster: huge })).length).toBeLessThanOrEqual(6002);
  });
});

describe("profileFingerprint", () => {
  it("is stable for the same profile", () => {
    expect(profileFingerprint(profileDigest(makeProfile()))).toBe(
      profileFingerprint(profileDigest(makeProfile())),
    );
  });

  it("changes when the resume changes — this is what marks a score stale", () => {
    const before = profileFingerprint(profileDigest(makeProfile()));
    const after = profileFingerprint(
      profileDigest(makeProfile({ resumeMaster: RESUME.replace("Playwright", "Selenium") })),
    );
    expect(after).not.toBe(before);
  });
});

describe("profileSkillsText", () => {
  it("returns the resume's skills section, not the whole digest", () => {
    const t = profileSkillsText(makeProfile());
    expect(t).toContain("Vitest, Playwright browser automation");
    expect(t).not.toContain("Professional Summary");
    expect(t).not.toContain("Target roles");
  });

  it("falls back to skills.md when the resume has no skills section", () => {
    expect(profileSkillsText(makeProfile({ resumeMaster: "# CV\n\nno sections" }))).toContain(
      "Older skills note",
    );
  });
});
