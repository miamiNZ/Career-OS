/**
 * Tests for orchestrator.scanAppliedExpiry — the thorough Applied-positions expiry scan.
 *
 * Uses source "zeil" so enrichDescriptions makes no network call (only seek/linkedin/trademe
 * re-fetch), keeping the test offline and deterministic. Asserts an applied job whose listing
 * has closed gets FLAGGED (never dropped — status stays "applied").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { writeJobNote, getJobNoteById } from "../src/vault.js";
import { scanAppliedExpiry } from "../src/orchestrator.js";
import { vault } from "../src/config.js";
import type { Job } from "../src/types.js";

function makeZeilJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `zeil-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "zeil",
    title: "Software Engineer",
    company: "Acme Ltd",
    location: "Auckland",
    url: "https://zeil.com/jobs/job/abc123",
    description: "",
    engagement: "permanent",
    employmentType: "full-time",
    workArrangement: "onsite",
    ingestedAt: new Date().toISOString(),
    ...overrides,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

async function cleanJobsDir(): Promise<void> {
  try {
    const files = await fs.readdir(vault.jobsDir);
    await Promise.all(files.map((f) => fs.rm(path.join(vault.jobsDir, f), { force: true, recursive: true })));
  } catch {
    /* ok */
  }
}

beforeEach(async () => {
  await fs.mkdir(vault.jobsDir, { recursive: true });
  await cleanJobsDir();
});
afterEach(cleanJobsDir);

describe("scanAppliedExpiry", () => {
  it("flags a closed applied listing but leaves it in Applied", async () => {
    const job = makeZeilJob({ closesAt: daysAgo(2) });
    await writeJobNote(job, "applied");

    const r = await scanAppliedExpiry();
    expect(r.scanned).toBe(1);
    expect(r.flagged).toBe(1);

    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("applied"); // never dropped
    expect(note?.data.expired).toBe(true);
    expect(note?.data.expiredReason).toBe("closed");
  });

  it("does not flag an applied listing that is still open", async () => {
    const job = makeZeilJob({ closesAt: daysAhead(20) });
    await writeJobNote(job, "applied");

    const r = await scanAppliedExpiry();
    expect(r.flagged).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.expired).toBeFalsy();
    expect(note?.data.status).toBe("applied");
  });

  it("ignores jobs that are not in Applied", async () => {
    const job = makeZeilJob({ closesAt: daysAgo(2) });
    await writeJobNote(job, "lead");

    const r = await scanAppliedExpiry();
    expect(r.scanned).toBe(0);
    expect(r.flagged).toBe(0);
  });
});
