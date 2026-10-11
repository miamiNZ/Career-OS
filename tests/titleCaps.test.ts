import { describe, it, expect } from "vitest";
import { capForTitle, isCappedQuery, titleCapsFor } from "../src/titleCaps.js";

const prefs = (fm: string) => `---\n${fm}\n---\n\n# Job Preferences`;

const CAPS = titleCapsFor(
  prefs(
    [
      "title_fit_caps:",
      "  - title: manager",
      "    max_fit: 40",
      "    unless: [engineering]",
      "  - title: team lead",
      "    max_fit: 30",
    ].join("\n"),
  ),
);

describe("titleCapsFor", () => {
  it("reads each cap from the preferences frontmatter", () => {
    expect(CAPS).toEqual([
      { title: "manager", maxFit: 40, unless: ["engineering"] },
      { title: "team lead", maxFit: 30, unless: [] },
    ]);
  });

  it("accepts `unless` as a comma-separated string", () => {
    const [cap] = titleCapsFor(prefs("title_fit_caps:\n  - title: director\n    max_fit: 30\n    unless: engineering, product"));
    expect(cap?.unless).toEqual(["engineering", "product"]);
  });

  it("returns no caps when none are configured or the note has no frontmatter", () => {
    expect(titleCapsFor(prefs("min_salary: 75000"))).toEqual([]);
    expect(titleCapsFor("# Job Preferences")).toEqual([]);
    expect(titleCapsFor()).toEqual([]);
  });

  it("skips entries it cannot use instead of guessing", () => {
    const caps = titleCapsFor(
      prefs(
        [
          "title_fit_caps:",
          "  - title: manager",
          "  - max_fit: 50",
          "  - title: director",
          "    max_fit: 150",
          "  - title: consultant",
          "    max_fit: 45",
        ].join("\n"),
      ),
    );
    expect(caps.map((c) => c.title)).toEqual(["consultant"]);
  });
});

describe("capForTitle", () => {
  it("caps a title that names the role as a whole word, in any case", () => {
    expect(capForTitle("Delivery Manager", CAPS)?.maxFit).toBe(40);
    expect(capForTitle("PROJECT MANAGERS", CAPS)?.maxFit).toBe(40);
  });

  it("leaves a title alone when it also carries an `unless` word", () => {
    expect(capForTitle("Engineering Manager", CAPS)).toBeUndefined();
  });

  it("does not match inside another word", () => {
    expect(capForTitle("Managerial Accountant", CAPS)).toBeUndefined();
  });

  it("matches a multi-word title across any spacing", () => {
    expect(capForTitle("Software  Team Lead", CAPS)?.maxFit).toBe(30);
  });

  it("applies the tightest cap when several match", () => {
    expect(capForTitle("Manager and Team Lead", CAPS)?.maxFit).toBe(30);
  });

  it("caps nothing with no caps configured", () => {
    expect(capForTitle("Delivery Manager", [])).toBeUndefined();
  });
});

describe("isCappedQuery", () => {
  it("flags a query for the capped role, including its other word forms", () => {
    expect(isCappedQuery("delivery manager", CAPS)).toBe(true);
    expect(isCappedQuery("project managers", CAPS)).toBe(true);
    expect(isCappedQuery("senior software engineer", CAPS)).toBe(false);
  });
});
