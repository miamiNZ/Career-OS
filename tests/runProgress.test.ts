/**
 * Tests for runProgress — the state the dashboard polls to show that opportunities are
 * being retrieved, and how many were found.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  startRun,
  updateRun,
  finishRun,
  failRun,
  getRunProgress,
  resetRunProgress,
} from "../src/runProgress.js";

beforeEach(resetRunProgress);

describe("runProgress", () => {
  it("starts idle", () => {
    const p = getRunProgress();
    expect(p.running).toBe(false);
    expect(p.phase).toBe("idle");
    expect(p.found).toBe(0);
  });

  it("reports a run in flight with its found count", () => {
    startRun();
    updateRun({ phase: "searching", found: 42, message: "Retrieving opportunities…" });
    const p = getRunProgress();
    expect(p.running).toBe(true);
    expect(p.phase).toBe("searching");
    expect(p.found).toBe(42);
  });

  it("summarises the finished run", () => {
    startRun();
    updateRun({ found: 42 });
    finishRun({ kept: 12, duplicates: 5 });
    const p = getRunProgress();
    expect(p.running).toBe(false);
    expect(p.phase).toBe("done");
    expect(p.finishedAt).toBeTruthy();
    expect(p.message).toContain("Found 42 opportunities");
    expect(p.message).toContain("12 kept");
    expect(p.message).toContain("5 already on the board");
  });

  it("singularises a single find", () => {
    startRun();
    finishRun({ found: 1, kept: 1 });
    expect(getRunProgress().message).toContain("Found 1 opportunity");
  });

  it("keeps the counts it reached when a run fails", () => {
    startRun();
    updateRun({ found: 7 });
    failRun("seek timed out");
    const p = getRunProgress();
    expect(p.running).toBe(false);
    expect(p.phase).toBe("error");
    expect(p.error).toBe("seek timed out");
    expect(p.found).toBe(7);
  });

  it("ignores updates once the run is over", () => {
    // A late phase update from a straggling await must not resurrect a finished run.
    startRun();
    finishRun({ found: 3, kept: 3 });
    updateRun({ phase: "scoring", found: 999 });
    const p = getRunProgress();
    expect(p.phase).toBe("done");
    expect(p.found).toBe(3);
  });

  it("bumps seq on each run so a client can tell them apart", () => {
    startRun();
    const first = getRunProgress().seq;
    finishRun({ found: 1, kept: 1 });
    startRun();
    expect(getRunProgress().seq).toBe(first + 1);
  });

  it("clears the previous run's error and counts on restart", () => {
    startRun();
    updateRun({ found: 9 });
    failRun("boom");
    startRun();
    const p = getRunProgress();
    expect(p.error).toBeNull();
    expect(p.found).toBe(0);
    expect(p.running).toBe(true);
  });

  it("hands back a copy, so a caller can't mutate the live state", () => {
    startRun();
    updateRun({ bySite: { seek: { count: 3 } } });
    const p = getRunProgress();
    p.bySite.seek = { count: 999 };
    expect(getRunProgress().bySite.seek?.count).toBe(3);
  });
});
