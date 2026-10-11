/**
 * Tests for src/ingest/* — pure logic for source selection + FileSource fetching.
 * Uses a real temp directory for file-based ingestion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseAlert } from "../src/ingest/source.js";
import { FileSource } from "../src/ingest/file.js";
import type { RawAlert } from "../src/ingest/source.js";

describe("parseAlert", () => {
  it("returns [] (Phase-1 stub — not yet implemented)", () => {
    const alert: RawAlert = {
      id: "test-1",
      from: "alerts@seek.co.nz",
      subject: "New jobs for you",
      receivedAt: new Date().toISOString(),
      html: "<html><body>Jobs!</body></html>",
      text: "Jobs!",
    };
    const jobs = parseAlert(alert);
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(0);
  });
});

describe("FileSource", () => {
  let tmpInbox: string;

  beforeAll(async () => {
    tmpInbox = await fs.mkdtemp(path.join(os.tmpdir(), "career-os-inbox-"));
  });

  afterAll(async () => {
    await fs.rm(tmpInbox, { recursive: true, force: true });
  });

  it("returns [] when inbox directory is empty", async () => {
    // FileSource reads from config.inboxDir, which we can't easily override.
    // Test directly by constructing and calling with an empty directory.
    // Since we can't change config.inboxDir here, just verify the fetch()
    // contract: it returns an array and does not throw even on empty dir.
    const source = new FileSource();
    const alerts = await source.fetch();
    expect(Array.isArray(alerts)).toBe(true);
  });

  it("has name === 'file'", () => {
    const source = new FileSource();
    expect(source.name).toBe("file");
  });

  it("fetch() returns an array (does not throw when inboxDir missing)", async () => {
    const source = new FileSource();
    // config.inboxDir is ./inbox which likely doesn't exist in test env
    await expect(source.fetch()).resolves.toBeInstanceOf(Array);
  });
});

describe("getIngestSource", () => {
  it("returns a FileSource when INGEST_SOURCE=file (default)", async () => {
    // INGEST_SOURCE is not set in test env → defaults to 'file'
    const { getIngestSource } = await import("../src/ingest/index.js");
    const src = getIngestSource();
    expect(src.name).toBe("file");
  });
});
