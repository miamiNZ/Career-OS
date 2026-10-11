/**
 * Tests for clearing the Applied / Unsuccessful columns without losing the exclusion.
 *
 * The board decides "you already applied for this" by indexing the Applied and
 * Unsuccessful notes, so archiving those notes is only safe if something else remembers
 * the roles. That something is Career/applied-history.json, and these tests pin the two
 * halves of the contract: the notes leave the board, and the roles stay excluded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import {
  archiveApplied,
  readAppliedHistory,
  recordAppliedHistory,
  listJobNotes,
  type JobNote,
} from "../src/vault.js";
import { buildDecidedIndex, matchesRole } from "../src/orchestrator.js";
import { vault } from "../src/config.js";
import type { AppliedHistoryEntry, JobStatus } from "../src/types.js";

async function writeNote(
  name: string,
  data: Record<string, unknown>,
  status: JobStatus,
): Promise<void> {
  await fs.mkdir(vault.jobsDir, { recursive: true });
  await fs.writeFile(
    path.join(vault.jobsDir, `${name}.md`),
    matter.stringify("## Description\n\nsomething", { id: name, source: "seek", status, ...data }),
    "utf8",
  );
}

async function reset(): Promise<void> {
  await fs.rm(vault.jobsDir, { recursive: true, force: true });
  await fs.rm(vault.appliedHistory, { force: true });
  await fs.mkdir(vault.jobsDir, { recursive: true });
}

beforeEach(reset);
afterEach(reset);

describe("archiveApplied", () => {
  it("moves Applied and Unsuccessful notes off the board and records them", async () => {
    await writeNote("a", { title: "Platform Engineer", company: "Acme Ltd", applied: "2026-07-01" }, "applied");
    await writeNote("b", { title: "Data Engineer", company: "Beta Ltd" }, "unsuccessful");
    await writeNote("c", { title: "Frontend Developer", company: "Gamma Ltd" }, "lead");

    const r = await archiveApplied();
    expect(r.scanned).toBe(2);
    expect(r.archived).toBe(2);
    expect(r.recorded).toBe(2);

    // The board now holds only the lead.
    const left = await listJobNotes();
    expect(left.map((n) => n.data.id)).toEqual(["c"]);

    // The note files themselves still exist, one folder down.
    const archived = await fs.readdir(vault.archiveDir);
    expect(archived.sort()).toEqual(["a.md", "b.md"]);

    const history = await readAppliedHistory();
    expect(history.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(history.find((e) => e.id === "a")).toMatchObject({
      title: "Platform Engineer",
      company: "Acme Ltd",
      status: "applied",
      applied: "2026-07-01",
    });
    expect(history.find((e) => e.id === "b")?.status).toBe("unsuccessful");
  });

  it("a dry run reports what it would clear and writes nothing", async () => {
    await writeNote("a", { title: "Platform Engineer", company: "Acme Ltd" }, "applied");

    const r = await archiveApplied({ dryRun: true });
    expect(r.scanned).toBe(1);
    expect(r.archived).toBe(0);
    expect(r.entries).toHaveLength(1);
    expect((await listJobNotes()).map((n) => n.data.id)).toEqual(["a"]);
    expect(await readAppliedHistory()).toEqual([]);
  });

  it("keeps the roles excluded from a later search run", async () => {
    // The whole point: after the columns are cleared, a listing for the same role must
    // still be recognised as one you've already applied for.
    await writeNote("a", { title: "Platform Engineer", company: "Acme Ltd" }, "applied");
    await writeNote("b", { title: "Data Engineer", company: "Beta Ltd" }, "unsuccessful");
    await archiveApplied();

    const notes = await listJobNotes();
    const idx = buildDecidedIndex(notes, await readAppliedHistory());
    expect(matchesRole({ title: "Platform Engineer", company: "Acme Limited" }, idx)).toBe(true);
    expect(matchesRole({ title: "Data Engineer", company: "Beta" }, idx)).toBe(true);
    // A role you never applied for is still free to arrive.
    expect(matchesRole({ title: "Frontend Developer", company: "Gamma Ltd" }, idx)).toBe(false);
  });

  it("is a no-op when the columns are already empty", async () => {
    await writeNote("c", { title: "Frontend Developer", company: "Gamma Ltd" }, "lead");
    const r = await archiveApplied();
    expect(r).toMatchObject({ scanned: 0, archived: 0, recorded: 0, historyTotal: 0 });
    expect((await listJobNotes()).map((n) => n.data.id)).toEqual(["c"]);
  });
});

describe("applied-history ledger", () => {
  const entry = (over: Partial<AppliedHistoryEntry> = {}): AppliedHistoryEntry => ({
    id: "x",
    title: "Platform Engineer",
    company: "Acme Ltd",
    status: "applied",
    archivedAt: new Date().toISOString(),
    ...over,
  });

  it("merges by id rather than appending a second copy", async () => {
    await recordAppliedHistory([entry(), entry({ id: "y", title: "Data Engineer" })]);
    const r = await recordAppliedHistory([entry({ status: "unsuccessful" })]);
    expect(r).toEqual({ added: 0, total: 2 });
    const history = await readAppliedHistory();
    expect(history).toHaveLength(2);
    expect(history.find((e) => e.id === "x")?.status).toBe("unsuccessful");
  });

  it("treats an unreadable ledger as empty instead of throwing", async () => {
    await fs.mkdir(path.dirname(vault.appliedHistory), { recursive: true });
    await fs.writeFile(vault.appliedHistory, "{ not json", "utf8");
    expect(await readAppliedHistory()).toEqual([]);
  });

  it("archived roles carry the same url match a note would", async () => {
    // Seek re-issues ids and re-words titles; the url is what identifies the same ad.
    const url = "https://seek.co.nz/job/12345";
    const idx = buildDecidedIndex([] as JobNote[], [entry({ url })]);
    expect(
      matchesRole({ title: "Platform Engineer - Integration", company: "Acme Group NZ", url }, idx),
    ).toBe(true);
  });
});
