/**
 * Tests for orchestrator.dedupeOpportunities — the sweep that drops an Opportunity whose
 * role is already in Applied/Unsuccessful/Dropped, or is listed twice across sites.
 *
 * The property that matters most here is idempotence: the sweep records `dropReason:
 * duplicate` on every note it drops, and must never treat one of those as evidence on a
 * later pass — otherwise it drops copy B, then drops copy A as "already dropped", and
 * keeps eating the board one run at a time.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { writeJobNote, getJobNoteById, listJobNotes } from "../src/vault.js";
import { dedupeOpportunities } from "../src/orchestrator.js";
import { vault } from "../src/config.js";
import type { Job, JobStatus } from "../src/types.js";

let seq = 0;
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Date.now()}-${seq++}`,
    source: "seek",
    title: "Software Engineer",
    company: "Acme Ltd",
    location: "Hamilton",
    url: `https://seek.co.nz/job/${seq}`,
    description: "",
    engagement: "permanent",
    employmentType: "full-time",
    workArrangement: "onsite",
    ingestedAt: new Date().toISOString(),
    ...overrides,
  };
}

const write = (o: Partial<Job>, status: JobStatus) => writeJobNote(makeJob(o), status);

async function cleanJobsDir(): Promise<void> {
  try {
    const files = await fs.readdir(vault.jobsDir);
    await Promise.all(files.map((f) => fs.rm(path.join(vault.jobsDir, f), { force: true, recursive: true })));
  } catch {
    /* ok */
  }
}

const statusOf = async (id: string) => (await getJobNoteById(id))?.data.status;

beforeEach(async () => {
  await fs.mkdir(vault.jobsDir, { recursive: true });
  await cleanJobsDir();
});
afterEach(cleanJobsDir);

describe("dedupeOpportunities", () => {
  it("drops a lead whose role is already in Applied, recording why", async () => {
    await write({ title: "Platform Engineer", company: "Acme Ltd" }, "applied");
    const lead = makeJob({ title: "Platform Engineer", company: "Acme Limited", source: "zeil" });
    await writeJobNote(lead, "lead");

    const r = await dedupeOpportunities();
    expect(r.dropped).toBe(1);
    expect(r.vsApplied).toBe(1);

    const note = await getJobNoteById(lead.id);
    expect(note?.data.status).toBe("dropped");
    expect(note?.data.dropReason).toBe("duplicate");
    expect(String(note?.data.duplicateOf)).toContain("Platform Engineer");
  });

  it("drops a lead whose role is already in Dropped", async () => {
    await write({ title: "Data Engineer", company: "Beta Ltd" }, "dropped");
    const lead = makeJob({ title: "Data Engineer", company: "Beta", source: "linkedin" });
    await writeJobNote(lead, "lead");

    const r = await dedupeOpportunities();
    expect(r.vsDropped).toBe(1);
    expect(await statusOf(lead.id)).toBe("dropped");
  });

  it("keeps the higher-priority source when the same role is listed twice", async () => {
    const seekJob = makeJob({ title: "Backend Developer", company: "Gamma Ltd", source: "seek" });
    const linkedInJob = makeJob({ title: "Backend Developer", company: "Gamma Limited", source: "linkedin" });
    await writeJobNote(seekJob, "lead");
    await writeJobNote(linkedInJob, "lead");

    const r = await dedupeOpportunities();
    expect(r.vsSelf).toBe(1);
    expect(await statusOf(seekJob.id)).toBe("lead"); // Seek carries the fuller description
    expect(await statusOf(linkedInJob.id)).toBe("dropped");
  });

  it("is idempotent — a second pass drops nothing", async () => {
    const keeper = makeJob({ title: "Backend Developer", company: "Gamma Ltd", source: "seek" });
    await writeJobNote(keeper, "lead");
    await writeJobNote(makeJob({ title: "Backend Developer", company: "Gamma Limited", source: "linkedin" }), "lead");
    await writeJobNote(makeJob({ title: "Site Reliability Engineer", company: "Delta Ltd" }), "applied");
    await writeJobNote(makeJob({ title: "Site Reliability Engineer", company: "Delta", source: "zeil" }), "lead");

    expect((await dedupeOpportunities()).dropped).toBe(2);
    expect((await dedupeOpportunities()).dropped).toBe(0);
    expect((await dedupeOpportunities()).dropped).toBe(0);

    // The survivor is still on the board — the sweep never ate its own keeper.
    const leads = (await listJobNotes()).filter((n) => n.data.status === "lead");
    expect(leads.map((n) => n.data.id)).toEqual([keeper.id]);
  });

  it("drops a lead whose role is already Unsuccessful", async () => {
    // An application you sent and lost is still one you sent — the listing shouldn't
    // return as a fresh lead.
    await write({ title: "Integration Developer", company: "Epsilon Ltd" }, "unsuccessful");
    const lead = makeJob({ title: "Integration Developer", company: "Epsilon", source: "zeil" });
    await writeJobNote(lead, "lead");

    const r = await dedupeOpportunities();
    expect(r.vsApplied).toBe(1);
    expect(await statusOf(lead.id)).toBe("dropped");
  });

  it("keeps the copy the user has progressed, not the better source", async () => {
    // The tailored copy carries a generated resume + cover letter. Dropping it to keep a
    // pristine Seek lead would throw that work away, so stage beats source rank.
    const seekLead = makeJob({ title: "Staff Engineer", company: "Zeta Ltd", source: "seek" });
    const tailored = makeJob({ title: "Staff Engineer", company: "Zeta Limited", source: "linkedin" });
    await writeJobNote(seekLead, "lead");
    await writeJobNote(tailored, "tailoring");

    const r = await dedupeOpportunities();
    expect(r.vsSelf).toBe(1);
    expect(await statusOf(tailored.id)).toBe("tailoring");
    expect(await statusOf(seekLead.id)).toBe("dropped");
  });

  it("reports the ids it dropped", async () => {
    await write({ title: "Network Engineer", company: "Eta Ltd" }, "applied");
    const lead = makeJob({ title: "Network Engineer", company: "Eta", source: "zeil" });
    await writeJobNote(lead, "lead");

    const r = await dedupeOpportunities();
    expect(r.droppedIds).toEqual([lead.id]);
  });

  it("drops a second note for the same posting url", async () => {
    // Two ids, one ad — the boards re-issue ids, and the url is what actually identifies it.
    const url = "https://seek.co.nz/job/shared-posting";
    const first = makeJob({ title: "API Developer", company: "Iota Ltd", url, source: "seek" });
    const second = makeJob({ title: "API Developer (Remote)", company: "", url, source: "linkedin" });
    await writeJobNote(first, "lead");
    await writeJobNote(second, "lead");

    const r = await dedupeOpportunities();
    expect(r.vsSelf).toBe(1);
    expect(await statusOf(first.id)).toBe("lead");
    expect(await statusOf(second.id)).toBe("dropped");
  });

  it("leaves genuinely distinct roles alone", async () => {
    await writeJobNote(makeJob({ title: "Software Engineer", company: "Acme Ltd" }), "lead");
    await writeJobNote(makeJob({ title: "Software Engineer", company: "Umbrella Ltd" }), "lead");
    await writeJobNote(makeJob({ title: "QA Analyst", company: "Acme Ltd" }), "lead");

    const r = await dedupeOpportunities();
    expect(r.scanned).toBe(3);
    expect(r.dropped).toBe(0);
  });

  it("dryRun reports without writing", async () => {
    await write({ title: "Cloud Engineer", company: "Acme Ltd" }, "applied");
    // Different company spelling → a different note filename, same normalized role.
    const lead = makeJob({ title: "Cloud Engineer", company: "Acme Limited", source: "zeil" });
    await writeJobNote(lead, "lead");

    const r = await dedupeOpportunities({ dryRun: true });
    expect(r.dropped).toBe(1);
    expect(await statusOf(lead.id)).toBe("lead");
  });
});
