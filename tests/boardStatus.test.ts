/**
 * Tests for src/boardStatus.ts — the fold that decides which board column a note appears in.
 *
 * This exists to keep one promise: the nav badge count for a screen equals the number of
 * cards that screen renders. Both sides go through these functions, so the invariant is
 * tested here once rather than trusted twice.
 */
import { describe, it, expect } from "vitest";
import { boardStatusOf, countByStatus, STATUS_ORDER } from "../src/boardStatus.js";

const note = (status?: unknown) => ({ data: status === undefined ? {} : { status } });

describe("boardStatusOf", () => {
  it("keeps every status the board actually has a column for", () => {
    for (const s of STATUS_ORDER) expect(boardStatusOf({ status: s })).toBe(s);
  });

  it("treats a note with no status as a lead", () => {
    expect(boardStatusOf({})).toBe("lead");
  });

  it("folds an unrecognised status back to lead rather than dropping it from the UI", () => {
    // Notes written by an older version carry retired stage names. Hiding them everywhere
    // would silently lose work the user can still act on.
    expect(boardStatusOf({ status: "reviewing" })).toBe("lead");
    expect(boardStatusOf({ status: "" })).toBe("lead");
    expect(boardStatusOf({ status: 42 })).toBe("lead");
  });

  it("keeps a retired dropped-like stage meaning dropped", () => {
    expect(boardStatusOf({ status: "dropped" })).toBe("dropped");
  });
});

describe("countByStatus", () => {
  it("returns every column, including the empty ones", () => {
    const counts = countByStatus([]);
    expect(Object.keys(counts).sort()).toEqual([...STATUS_ORDER].sort());
    for (const s of STATUS_ORDER) expect(counts[s]).toBe(0);
  });

  it("tallies each note into exactly one column", () => {
    const counts = countByStatus([
      note("lead"), note("lead"), note("interested"),
      note("tailoring"), note("applied"), note("dropped"), note("dropped"),
    ]);
    expect(counts.lead).toBe(2);
    expect(counts.interested).toBe(1);
    expect(counts.tailoring).toBe(1);
    expect(counts.applied).toBe(1);
    expect(counts.unsuccessful).toBe(0);
    expect(counts.dropped).toBe(2);
  });

  it("counts folded and status-less notes as leads, so none go missing", () => {
    const notes = [note(), note("reviewing"), note("lead")];
    const counts = countByStatus(notes);
    expect(counts.lead).toBe(3);
    const total = STATUS_ORDER.reduce((sum, s) => sum + counts[s], 0);
    expect(total).toBe(notes.length);
  });

  it("never loses or double-counts a note", () => {
    const notes = [
      note("lead"), note("interested"), note("tailoring"), note("applied"),
      note("unsuccessful"), note("dropped"), note("who-knows"), note(),
    ];
    const total = STATUS_ORDER.reduce((sum, s) => sum + countByStatus(notes)[s], 0);
    expect(total).toBe(notes.length);
  });

  it("sums the Opportunities badge the way the Opportunities screen groups columns", () => {
    // app.js VIEWS maps /opportunities to ["lead", "interested"]; nav.js sums the same pair.
    const counts = countByStatus([note("lead"), note("lead"), note("interested"), note("applied")]);
    expect(counts.lead + counts.interested).toBe(3);
  });
});
