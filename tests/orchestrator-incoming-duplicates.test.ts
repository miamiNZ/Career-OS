/**
 * Tests for the gate a search run puts in front of INCOMING listings: before a job is
 * written as a note, it is checked against the roles the board already holds a decision
 * on (Applied / Unsuccessful) and the ones you've already dropped.
 *
 * This is the check the user relies on to not be shown the same job twice. The cases
 * below are the ways it used to leak: the same ad re-crawled under a new id, a role that
 * came back "unsuccessful" being treated as never-applied-for, and a listing whose
 * company field the boards word differently.
 */
import { describe, it, expect } from "vitest";

import {
  buildDecidedIndex,
  buildDroppedIndex,
  buildStatusIndex,
  matchesRole,
} from "../src/orchestrator.js";
import type { JobNote } from "../src/vault.js";
import type { JobStatus } from "../src/types.js";

let seq = 0;
function note(data: Record<string, unknown>, status: JobStatus): JobNote {
  return {
    file: `/tmp/note-${seq++}.md`,
    data: { id: `id-${seq}`, source: "seek", status, ...data },
    body: "",
  } as JobNote;
}

describe("incoming-listing duplicate gate", () => {
  it("recognises a role already in Applied", () => {
    const idx = buildDecidedIndex([note({ title: "Platform Engineer", company: "Acme Ltd" }, "applied")]);
    expect(matchesRole({ title: "Platform Engineer", company: "Acme Limited" }, idx)).toBe(true);
  });

  it("recognises a role already marked Unsuccessful", () => {
    // You applied and were turned down — the listing is still one you've handled, so a
    // later run must not offer it back as a fresh lead.
    const idx = buildDecidedIndex([note({ title: "Data Engineer", company: "Beta Ltd" }, "unsuccessful")]);
    expect(matchesRole({ title: "Data Engineer", company: "Beta" }, idx)).toBe(true);
  });

  it("matches the same posting url even when the title and company changed", () => {
    // Seek re-issues ids and re-words titles; the url is the same ad.
    const url = "https://seek.co.nz/job/12345";
    const idx = buildDecidedIndex([note({ title: "Senior Developer", company: "Acme Ltd", url }, "applied")]);
    expect(matchesRole({ title: "Senior Developer - Integration", company: "Acme Group NZ", url }, idx)).toBe(true);
  });

  it("recognises a role you already dropped", () => {
    const idx = buildDroppedIndex([note({ title: "Payroll Specialist", company: "Gamma Ltd" }, "dropped")]);
    expect(matchesRole({ title: "Payroll Specialist", company: "Gamma" }, idx)).toBe(true);
  });

  it("ignores notes dropped as duplicates, so a genuine re-listing can come back", () => {
    // A note dropped BY the de-dupe sweep is the discarded copy of a live role, not a
    // decision — counting it would block the role from ever arriving again.
    const idx = buildDroppedIndex([
      note({ title: "Cloud Engineer", company: "Delta Ltd", dropReason: "duplicate" }, "dropped"),
    ]);
    expect(idx.size).toBe(0);
    expect(matchesRole({ title: "Cloud Engineer", company: "Delta Ltd" }, idx)).toBe(false);
  });

  it("lets the same generic title at a different company through", () => {
    // The regression this guards: "Senior Developer" is reused across dozens of unrelated
    // employers, so a title-only match would silently discard a brand-new role.
    const idx = buildDecidedIndex([note({ title: "Senior Developer", company: "Acme Ltd" }, "applied")]);
    expect(matchesRole({ title: "Senior Developer", company: "Umbrella Ltd" }, idx)).toBe(false);
  });

  it("won't match a company-less listing on a generic title alone", () => {
    // LinkedIn/ZEIL often carry no company. A short title is not a fingerprint.
    const idx = buildDecidedIndex([note({ title: "Software Engineer", company: "Acme Ltd" }, "applied")]);
    expect(matchesRole({ title: "Software Engineer" }, idx)).toBe(false);
  });

  it("does match a company-less listing on a distinctive title", () => {
    const title = "senior integration developer healthcare platform";
    const idx = buildDecidedIndex([note({ title, company: "Acme Ltd" }, "applied")]);
    expect(matchesRole({ title }, idx)).toBe(true);
  });

  it("leaves leads and interested roles out of the decided index", () => {
    // Only Applied/Unsuccessful count as decided — an active lead must not block its own
    // refresh, or a re-run would never update the note it already wrote.
    const idx = buildDecidedIndex([
      note({ title: "Backend Developer", company: "Acme Ltd" }, "lead"),
      note({ title: "Frontend Developer", company: "Acme Ltd" }, "interested"),
      note({ title: "Mobile Developer", company: "Acme Ltd" }, "tailoring"),
    ]);
    expect(idx.size).toBe(0);
  });

  it("indexes each status set independently", () => {
    const notes = [
      note({ title: "Alpha Engineer", company: "A Ltd" }, "applied"),
      note({ title: "Beta Engineer", company: "B Ltd" }, "unsuccessful"),
      note({ title: "Gamma Engineer", company: "C Ltd" }, "dropped"),
    ];
    expect(buildStatusIndex(notes, "applied").size).toBe(1);
    expect(buildDecidedIndex(notes).size).toBe(2);
    expect(buildDroppedIndex(notes).size).toBe(1);
  });
});
