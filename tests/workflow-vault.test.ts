/**
 * Tests for src/workflow.ts — vault-integrated functions (dropJob, markApplied, setStatus).
 * Uses a real vault temp dir. Does NOT test markInterested (which calls applicationAgent
 * and convertBoth — too many external dependencies for a unit test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

// Mock applicationAgent + convertBoth so markInterested doesn't hit disk/ollama
vi.mock("../src/agents/application.js", () => ({
  applicationAgent: vi.fn().mockResolvedValue({
    jobId: "job-1",
    slug: "acme-ltd-senior-developer",
    dir: "/tmp/fake-apps",
    resumeFile: "/tmp/fake-apps/resume.md",
    coverFile: "/tmp/fake-apps/cover-letter.md",
    jobFile: "/tmp/fake-apps/job.md",
    tailored: true,
    reviewed: true,
  }),
}));

vi.mock("../src/convert.js", () => ({
  convertBoth: vi.fn().mockResolvedValue({ files: [], errors: [], wordUnavailable: true }),
}));

import { dropJob, setStatus, markApplied, canTransition } from "../src/workflow.js";
import { writeJobNote, getJobNoteById } from "../src/vault.js";
import { vault } from "../src/config.js";
import type { Job } from "../src/types.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "seek",
    title: "Senior Developer",
    company: "Acme Ltd",
    location: "Wellington",
    url: `https://seek.co.nz/job/${Date.now()}`,
    description: ".NET developer needed.",
    engagement: "permanent",
    employmentType: "full-time",
    workArrangement: "hybrid",
    ingestedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function ensureJobsDir(): Promise<void> {
  await fs.mkdir(vault.jobsDir, { recursive: true });
}

async function cleanJobsDir(): Promise<void> {
  try {
    const files = await fs.readdir(vault.jobsDir);
    await Promise.all(
      files.map((f) => fs.rm(path.join(vault.jobsDir, f), { force: true, recursive: true })),
    );
  } catch { /* ok */ }
}

beforeEach(async () => {
  await ensureJobsDir();
  await cleanJobsDir();
});

afterEach(async () => {
  await cleanJobsDir();
});

describe("setStatus", () => {
  it("transitions lead → interested", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await setStatus(job.id, "interested");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("interested");
  });

  it("transitions interested → tailoring", async () => {
    const job = makeJob();
    await writeJobNote(job, "interested");
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.status = "interested";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");
    const result = await setStatus(job.id, "tailoring");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("tailoring");
  });

  it("returns ok=false for invalid transition (lead → applied)", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await setStatus(job.id, "applied");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Can't move");
  });

  it("returns ok=true message 'Already X' when already in that status", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await setStatus(job.id, "lead");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Already lead");
  });

  it("returns ok=false when job not found", async () => {
    const result = await setStatus("nonexistent-id", "interested");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("dropJob", () => {
  it("moves a lead job to dropped", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await dropJob(job.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("dropped");
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("dropped");
  });

  it("unticks the Interested checkbox when dropping", async () => {
    const job = makeJob();
    await writeJobNote(job, "interested");
    // First tick interested
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const updated = txt.replace("- [ ] Interested", "- [x] Interested");
    const fm = matter(updated);
    fm.data.status = "interested";
    fm.data.interested = true;
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");

    await dropJob(job.id);
    const note = await getJobNoteById(job.id);
    expect(note?.body).toContain("- [ ] Interested");
  });

  it("returns ok=false when job not found", async () => {
    const result = await dropJob("nonexistent-id");
    expect(result.ok).toBe(false);
  });
});

describe("markApplied", () => {
  it("marks tailoring job as applied with explicit date", async () => {
    const job = makeJob();
    await writeJobNote(job, "tailoring");
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.status = "tailoring";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");

    const result = await markApplied(job.id, "2026-07-01");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.message).toContain("2026-07-01");
  });

  it("defaults applied date to today when none given", async () => {
    const job = makeJob();
    await writeJobNote(job, "tailoring");
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.status = "tailoring";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");

    const result = await markApplied(job.id);
    expect(result.ok).toBe(true);
    const note = await getJobNoteById(job.id);
    // Applied date should be a valid YYYY-MM-DD
    expect(note?.data.applied).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects invalid date format (uses today instead)", async () => {
    const job = makeJob();
    await writeJobNote(job, "tailoring");
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.status = "tailoring";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");

    // Invalid date string → falls back to today
    const result = await markApplied(job.id, "not-a-date");
    expect(result.ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.applied).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns ok=false for a lead job (can't go lead → applied)", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await markApplied(job.id, "2026-07-01");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Can't move");
  });

  it("returns ok=false when job not found", async () => {
    const result = await markApplied("nonexistent-id", "2026-07-01");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("already-applied job can call markApplied again to update date", async () => {
    const job = makeJob();
    await writeJobNote(job, "applied");
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.status = "applied";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");
    // applied → applied is allowed (from=applied, canTransition(applied,applied) is false
    // but the markApplied code has `from === "applied"` short-circuit)
    const result = await markApplied(job.id, "2026-07-15");
    expect(result.ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.applied).toBe("2026-07-15");
  });
});
