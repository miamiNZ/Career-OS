/**
 * Tests for src/vault.ts — frontmatter parse/round-trip, note dedupe,
 * status/interested/applied mutations, expiry.
 *
 * Uses a real temp directory as the vault sandbox (no fs mocking needed).
 * Writes actual job notes then calls the vault API and asserts outcomes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";

// Vault module reads vault.jobsDir from config which uses VAULT_PATH env.
// We override vault paths dynamically by setting VAULT_PATH to our tmpDir before import.
// But since vitest.config.ts sets VAULT_PATH at startup we must point to the
// real temp dir post-hoc — so we use the per-test tmpDir with a workaround:
// write notes directly to the VAULT_PATH jobs dir, then call the vault functions.

import {
  writeJobNote,
  listJobNotes,
  getJobNoteById,
  setJobStatus,
  setInterested,
  setAppliedDate,
  setJobScore,
  dedupeNoteFilesById,
  existingJobIds,
  expireClosedJobs,
  flagExpiredApplied,
  updateAppliedListing,
  markJobExpired,
  listApplicationFiles,
  resolveApplicationFile,
} from "../src/vault.js";

import { vault } from "../src/config.js";

// The vault root is fixed at /tmp/career-os-test-vault (from vitest.config.ts).
// We create fresh sub-directories per test to keep isolation.

let tmpJobsDir: string;
let origJobsDir: string;

// Patch vault.jobsDir to point at our per-test temp dir via Object.defineProperty
// because vault is a const object — we need to temporarily redirect it.
// Instead, we will write notes directly into vault.jobsDir (which is fixed) and
// clean up after each test.

async function ensureJobsDir(): Promise<void> {
  await fs.mkdir(vault.jobsDir, { recursive: true });
}

async function cleanJobsDir(): Promise<void> {
  try {
    const files = await fs.readdir(vault.jobsDir);
    await Promise.all(
      files.map((f) => fs.rm(path.join(vault.jobsDir, f), { force: true, recursive: true })),
    );
  } catch {
    // ok
  }
}

import type { Job, JobStatus, Score } from "../src/types.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "seek",
    title: "Senior Developer",
    company: "Acme Ltd",
    location: "Wellington, NZ",
    url: `https://seek.co.nz/job/${Date.now()}`,
    description: "We need a .NET developer with AWS and C# experience.",
    salaryText: "$120k - $140k",
    salaryMin: 120_000,
    salaryMax: 140_000,
    engagement: "permanent",
    employmentType: "full-time",
    workArrangement: "hybrid",
    ingestedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeScore(jobId: string): Score {
  return {
    jobId,
    fit: 85,
    rejected: false,
    rejectReasons: [],
    matchedSkills: ["C#", ".NET", "AWS"],
    missingSkills: ["Kafka"],
    rationale: "Strong match",
  };
}

beforeEach(async () => {
  await ensureJobsDir();
  await cleanJobsDir();
});

afterEach(async () => {
  await cleanJobsDir();
});

describe("writeJobNote — transient share-lock retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries an EPERM write and still lands the note", async () => {
    // The vault lives on an SMB share, where Obsidian or an indexer holding a note
    // surfaces as EPERM rather than a lock error. Two transient failures then success.
    const real = fs.writeFile.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (++calls <= 2) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return real(...args);
    });

    const job = makeJob({ title: "Retried Role" });
    await expect(writeJobNote(job, "lead")).resolves.toBeTruthy();
    expect(calls).toBe(3);
    const note = await getJobNoteById(job.id);
    expect(note?.data.title).toBe("Retried Role");
  });

  it("gives up on an error a retry cannot fix", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValue(
      Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
    );
    await expect(writeJobNote(makeJob(), "lead")).rejects.toThrow(/ENOSPC/);
  });
});

describe("writeJobNote", () => {
  it("creates a new note file for a job", async () => {
    const job = makeJob();
    const file = await writeJobNote(job, "lead");
    expect(file).toBeTruthy();
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
  });

  it("note contains correct frontmatter id", async () => {
    const job = makeJob();
    const file = await writeJobNote(job, "lead");
    const txt = await fs.readFile(file, "utf8");
    const fm = matter(txt);
    expect(fm.data.id).toBe(job.id);
  });

  it("note contains correct status", async () => {
    const job = makeJob();
    const file = await writeJobNote(job, "interested");
    const txt = await fs.readFile(file, "utf8");
    const fm = matter(txt);
    expect(fm.data.status).toBe("interested");
  });

  it("note body contains Interested checkbox", async () => {
    const job = makeJob();
    const file = await writeJobNote(job, "lead");
    const txt = await fs.readFile(file, "utf8");
    expect(txt).toContain("- [ ] Interested");
  });

  it("note body includes the description", async () => {
    const job = makeJob({ description: "Looking for a C# expert with CQRS experience." });
    const file = await writeJobNote(job, "lead");
    const txt = await fs.readFile(file, "utf8");
    expect(txt).toContain("CQRS experience");
  });

  it("skips creating a duplicate when same file exists (same id finds existing)", async () => {
    const job = makeJob();
    const file1 = await writeJobNote(job, "lead");
    const file2 = await writeJobNote(job, "lead");
    // Should update the same file, not create a new one
    expect(file1).toBe(file2);
  });

  it("refreshes description with a longer one on subsequent write", async () => {
    const job = makeJob({ description: "Short." });
    const file = await writeJobNote(job, "lead");

    const longer = "Much longer description with more details about .NET and AWS requirements.";
    const updated = makeJob({ ...job, description: longer });
    await writeJobNote(updated, "lead");
    const txt = await fs.readFile(file, "utf8");
    expect(txt).toContain(longer);
  });

  it("writes employment type and work arrangement to frontmatter", async () => {
    const job = makeJob({ employmentType: "full-time", workArrangement: "remote" });
    const file = await writeJobNote(job, "lead");
    const txt = await fs.readFile(file, "utf8");
    const fm = matter(txt);
    expect(fm.data.employmentType).toBe("full-time");
    expect(fm.data.workArrangement).toBe("remote");
  });
});

describe("listJobNotes / getJobNoteById", () => {
  it("lists job notes after writing", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const notes = await listJobNotes();
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n) => n.data.id === job.id)).toBe(true);
  });

  it("excludes notes without a frontmatter id", async () => {
    // Write a stray markdown file without a proper id
    await fs.writeFile(
      path.join(vault.jobsDir, "stray-note.md"),
      "# Just a stray file\n\nNo frontmatter.",
      "utf8",
    );
    const notes = await listJobNotes();
    expect(notes.every((n) => !!n.data.id)).toBe(true);
  });

  it("excludes _template files", async () => {
    await fs.writeFile(
      path.join(vault.jobsDir, "_template.md"),
      "---\nid: template\n---\n# Template",
      "utf8",
    );
    const notes = await listJobNotes();
    expect(notes.every((n) => n.data.id !== "template")).toBe(true);
  });

  it("getJobNoteById returns the correct note", async () => {
    const job = makeJob({ title: "Integration Architect" });
    await writeJobNote(job, "lead");
    const note = await getJobNoteById(job.id);
    expect(note).toBeDefined();
    expect(note?.data.title).toBe("Integration Architect");
  });

  it("getJobNoteById returns undefined for unknown id", async () => {
    const note = await getJobNoteById("nonexistent-id-xyz");
    expect(note).toBeUndefined();
  });

  it("lists multiple notes", async () => {
    const jobs = [makeJob({ title: "Job A" }), makeJob({ title: "Job B" }), makeJob({ title: "Job C" })];
    await Promise.all(jobs.map((j) => writeJobNote(j, "lead")));
    const notes = await listJobNotes();
    expect(notes.length).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array when jobsDir is empty", async () => {
    const notes = await listJobNotes();
    expect(notes).toEqual([]);
  });
});

describe("setJobStatus", () => {
  it("updates status from lead to interested", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const ok = await setJobStatus(job.id, "interested");
    expect(ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("interested");
  });

  it("updates status to tailoring", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    await setJobStatus(job.id, "tailoring");
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("tailoring");
  });

  it("returns false for unknown id", async () => {
    const ok = await setJobStatus("no-such-id", "dropped");
    expect(ok).toBe(false);
  });

  it("sets statusChanged timestamp", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    await setJobStatus(job.id, "interested");
    const note = await getJobNoteById(job.id);
    expect(note?.data.statusChanged).toBeTruthy();
  });
});

describe("setInterested", () => {
  it("ticks the Interested checkbox", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    await setInterested(job.id, true);
    const note = await getJobNoteById(job.id);
    expect(note?.body).toContain("- [x] Interested");
  });

  it("unticks the Interested checkbox", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    await setInterested(job.id, true);
    await setInterested(job.id, false);
    const note = await getJobNoteById(job.id);
    expect(note?.body).toContain("- [ ] Interested");
  });

  it("sets interested frontmatter to true", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    await setInterested(job.id, true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.interested).toBe(true);
  });

  it("returns false for unknown id", async () => {
    const ok = await setInterested("nonexistent", true);
    expect(ok).toBe(false);
  });
});

describe("setAppliedDate", () => {
  it("writes the applied date to frontmatter", async () => {
    const job = makeJob();
    await writeJobNote(job, "tailoring");
    await setAppliedDate(job.id, "2026-07-01");
    const note = await getJobNoteById(job.id);
    expect(note?.data.applied).toBe("2026-07-01");
  });

  it("returns false for unknown id", async () => {
    const ok = await setAppliedDate("nonexistent", "2026-07-01");
    expect(ok).toBe(false);
  });
});

describe("setJobScore", () => {
  it("writes fit, rationale, matched/missing skills to frontmatter", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const score = makeScore(job.id);
    const ok = await setJobScore(job.id, score);
    expect(ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.fit).toBe(85);
    expect(note?.data.rationale).toBe("Strong match");
    expect(note?.data.matched).toContain("C#");
    expect(note?.data.missing).toContain("Kafka");
  });

  it("sets autoRejected flag when score.rejected is true", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const score = { ...makeScore(job.id), rejected: true, rejectReasons: ["salary too low"] };
    await setJobScore(job.id, score);
    const note = await getJobNoteById(job.id);
    expect(note?.data.autoRejected).toBe(true);
    expect(note?.data.rejectReasons).toContain("salary too low");
  });

  it("returns false for unknown id", async () => {
    const ok = await setJobScore("nonexistent", makeScore("nonexistent"));
    expect(ok).toBe(false);
  });
});

describe("dedupeNoteFilesById", () => {
  it("returns 0 when no duplicates exist", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const result = await dedupeNoteFilesById();
    expect(result.removed).toBe(0);
  });

  it("removes the shorter-description duplicate", async () => {
    const job = makeJob({ description: "Short description." });
    // Write the same note to two different filenames (simulating the old bug)
    const file1 = path.join(vault.jobsDir, "dup-a.md");
    const file2 = path.join(vault.jobsDir, "dup-b.md");
    const longDesc = "Much longer description with more detail about the .NET requirements.";
    const fm = { type: "job", id: job.id, status: "lead", source: "seek", company: "Acme", title: "Dev" };
    await fs.writeFile(file1, matter.stringify(`# Dev — Acme\n\n## Description\n\n${longDesc}\n`, fm), "utf8");
    await fs.writeFile(file2, matter.stringify(`# Dev — Acme\n\n## Description\n\nShort.\n`, fm), "utf8");

    const result = await dedupeNoteFilesById();
    expect(result.removed).toBe(1);

    // The shorter one should be gone, the longer kept
    const files = await fs.readdir(vault.jobsDir);
    expect(files).toHaveLength(1);
    const remaining = await fs.readFile(path.join(vault.jobsDir, files[0]!), "utf8");
    expect(remaining).toContain(longDesc);
  });
});

describe("existingJobIds", () => {
  it("returns empty set when no notes exist", async () => {
    const ids = await existingJobIds();
    expect(ids.size).toBe(0);
  });

  it("returns ids of all written notes", async () => {
    const jobs = [makeJob({ title: "Job A" }), makeJob({ title: "Job B" })];
    await Promise.all(jobs.map((j) => writeJobNote(j, "lead")));
    const ids = await existingJobIds();
    for (const j of jobs) {
      expect(ids.has(j.id)).toBe(true);
    }
  });
});

describe("expireClosedJobs", () => {
  it("marks expired jobs as dropped", async () => {
    const job = makeJob({
      closesAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    });
    await writeJobNote(job, "lead");
    // Set the closes field on the note
    const file = await getJobNoteById(job.id);
    // Update the note frontmatter closes field directly
    const txt = await fs.readFile(file!.file, "utf8");
    const fm = matter(txt);
    fm.data.closes = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fm.data.status = "lead";
    await fs.writeFile(file!.file, matter.stringify(fm.content, fm.data), "utf8");

    const count = await expireClosedJobs();
    expect(count).toBeGreaterThanOrEqual(1);

    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("dropped");
    expect(note?.data.expired).toBe(true);
  });

  it("does NOT expire jobs with no closes date", async () => {
    const job = makeJob({ closesAt: undefined });
    await writeJobNote(job, "lead");
    const count = await expireClosedJobs();
    expect(count).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("lead");
  });

  it("does NOT expire applied/interview/offer jobs", async () => {
    const job = makeJob({
      closesAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await writeJobNote(job, "applied");
    // Manually set closes + status=applied
    const noteRef = await getJobNoteById(job.id);
    const txt = await fs.readFile(noteRef!.file, "utf8");
    const fm = matter(txt);
    fm.data.closes = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fm.data.status = "applied";
    await fs.writeFile(noteRef!.file, matter.stringify(fm.content, fm.data), "utf8");

    const count = await expireClosedJobs();
    expect(count).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("applied");
  });
});

describe("flagExpiredApplied", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const daysAhead = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

  it("flags an applied job whose listing has closed WITHOUT changing its status", async () => {
    const job = makeJob({ closesAt: daysAgo(3) });
    await writeJobNote(job, "applied");
    const r = await flagExpiredApplied();
    expect(r.flagged).toBe(1);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("applied"); // stays in Applied — never dropped
    expect(note?.data.expired).toBe(true);
    expect(note?.data.expiredReason).toBe("closed");
    expect(note?.data.expiredDetected).toBeTruthy();
  });

  it("does NOT flag an applied job whose listing is still open", async () => {
    const job = makeJob({ closesAt: daysAhead(10) });
    await writeJobNote(job, "applied");
    const r = await flagExpiredApplied();
    expect(r.flagged).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.expired).toBeFalsy();
  });

  it("does NOT flag an applied job with no closing date", async () => {
    const job = makeJob({ closesAt: undefined });
    await writeJobNote(job, "applied");
    const r = await flagExpiredApplied();
    expect(r.flagged).toBe(0);
    expect(r.scanned).toBe(1);
  });

  it("ignores non-applied jobs (that's expireClosedJobs' job)", async () => {
    const job = makeJob({ closesAt: daysAgo(3) });
    await writeJobNote(job, "lead");
    const r = await flagExpiredApplied();
    expect(r.scanned).toBe(0);
    expect(r.flagged).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("lead");
    expect(note?.data.expired).toBeFalsy();
  });

  it("is idempotent — a second scan re-flags nothing", async () => {
    const job = makeJob({ closesAt: daysAgo(3) });
    await writeJobNote(job, "applied");
    await flagExpiredApplied();
    const r2 = await flagExpiredApplied();
    expect(r2.flagged).toBe(0);
  });

  it("self-heals: clears a date-based flag when the listing is re-opened", async () => {
    const job = makeJob({ closesAt: daysAgo(3) });
    await writeJobNote(job, "applied");
    await flagExpiredApplied(); // flags it
    // Listing re-opens: closing date pushed into the future.
    await updateAppliedListing(job.id, daysAhead(14));
    const r = await flagExpiredApplied();
    expect(r.cleared).toBe(1);
    const note = await getJobNoteById(job.id);
    expect(note?.data.expired).toBe(false);
    expect(note?.data.expiredReason).toBeUndefined();
  });

  it("never clears a source-confirmed 'gone' flag, even with a future close date", async () => {
    // Applied job still carries a future closing date, but the source says the ad is gone.
    const job = makeJob({ closesAt: daysAhead(14) });
    await writeJobNote(job, "applied");
    await updateAppliedListing(job.id, undefined, true); // confirmedGone → expiredReason: "gone"
    const r = await flagExpiredApplied();
    expect(r.cleared).toBe(0);
    const note = await getJobNoteById(job.id);
    expect(note?.data.expired).toBe(true);
    expect(note?.data.expiredReason).toBe("gone");
  });
});

describe("updateAppliedListing", () => {
  it("backfills a closing date without changing status", async () => {
    const job = makeJob({ closesAt: undefined });
    await writeJobNote(job, "applied");
    const iso = new Date().toISOString();
    const ok = await updateAppliedListing(job.id, iso);
    expect(ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.closes).toBe(iso);
    expect(note?.data.status).toBe("applied");
  });

  it("flags a source-confirmed gone listing without changing status", async () => {
    const job = makeJob();
    await writeJobNote(job, "applied");
    await updateAppliedListing(job.id, undefined, true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.expired).toBe(true);
    expect(note?.data.expiredReason).toBe("gone");
    expect(note?.data.status).toBe("applied");
  });

  it("returns false for an unknown id", async () => {
    const ok = await updateAppliedListing("nonexistent-id", new Date().toISOString());
    expect(ok).toBe(false);
  });
});

describe("listApplicationFiles / resolveApplicationFile", () => {
  const appSlug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

  async function makeAppFolder(job: Job): Promise<string> {
    const slug = `${appSlug(job.company || job.source)}-${appSlug(job.title)}`;
    const dir = path.join(vault.applicationsDir, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "resume.md"), "# Resume\n\nreal content here", "utf8");
    await fs.writeFile(path.join(dir, "cover-letter.md"), "Dear Hiring Team,\n\n…", "utf8");
    await fs.writeFile(path.join(dir, "resume.docx"), Buffer.from("PK\x03\x04docx-bytes"), "utf8");
    return dir;
  }

  it("lists the files in a job's application folder with sizes", async () => {
    const job = makeJob();
    await writeJobNote(job, "applied");
    await makeAppFolder(job);
    const files = await listApplicationFiles(job.id);
    const names = files.map((f) => f.name);
    expect(names).toContain("resume.md");
    expect(names).toContain("cover-letter.md");
    expect(names).toContain("resume.docx");
    expect(files.every((f) => f.size > 0)).toBe(true);
  });

  it("returns [] when the job has no application folder", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    expect(await listApplicationFiles(job.id)).toEqual([]);
  });

  it("resolves a valid file to its absolute path inside the folder", async () => {
    const job = makeJob();
    await writeJobNote(job, "applied");
    const dir = await makeAppFolder(job);
    const full = await resolveApplicationFile(job.id, "resume.md");
    expect(full).toBe(path.join(dir, "resume.md"));
  });

  it("rejects path traversal, absolute paths, and missing files", async () => {
    const job = makeJob();
    await writeJobNote(job, "applied");
    await makeAppFolder(job);
    expect(await resolveApplicationFile(job.id, "../../../../etc/passwd")).toBe("");
    expect(await resolveApplicationFile(job.id, "..\\..\\secret.txt")).toBe("");
    expect(await resolveApplicationFile(job.id, "/etc/passwd")).toBe("");
    expect(await resolveApplicationFile(job.id, "does-not-exist.md")).toBe("");
  });

  it("returns '' for an unknown job id", async () => {
    expect(await listApplicationFiles("no-such-id")).toEqual([]);
    expect(await resolveApplicationFile("no-such-id", "resume.md")).toBe("");
  });
});

describe("markJobExpired", () => {
  it("marks a job as dropped + expired", async () => {
    const job = makeJob();
    await writeJobNote(job, "lead");
    const ok = await markJobExpired(job.id);
    expect(ok).toBe(true);
    const note = await getJobNoteById(job.id);
    expect(note?.data.status).toBe("dropped");
    expect(note?.data.expired).toBe(true);
    expect(note?.data.interested).toBe(false);
  });

  it("returns false for unknown id", async () => {
    const ok = await markJobExpired("nonexistent-id");
    expect(ok).toBe(false);
  });
});

describe("writeFileRetry — concurrent writes to one note", () => {
  it("serialises same-file writes so the last one wins intact", async () => {
    // Two listings of the same role at the same employer arrive under different ids from
    // different boards; both slug to the same filename. Written concurrently, the file
    // must end up as one of the two whole notes, never a mix.
    const base: Job = {
      id: "seek-1",
      source: "seek",
      title: "Senior Software Developer",
      company: "Acme Ltd",
      url: "https://seek.co.nz/job/1",
      description: "A".repeat(20_000),
      engagement: "permanent",
      employmentType: "full-time",
      workArrangement: "onsite",
      ingestedAt: new Date().toISOString(),
    };
    const [a, b] = await Promise.all([
      writeJobNote(base, "lead"),
      writeJobNote({ ...base, id: "zeil-2", description: "B".repeat(20_000) }, "lead"),
    ]);
    expect(a).toBe(b); // same target file

    const text = await fs.readFile(a, "utf8");
    expect(text).not.toMatch(/AB|BA/); // no interleaved content
    expect(/A{20000}|B{20000}/.test(text)).toBe(true);
  });
});
