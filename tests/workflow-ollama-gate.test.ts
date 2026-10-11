/**
 * markInterested must refuse to start when the local LLM is down.
 *
 * Without the gate the tailoring agent silently writes untailored master copies and the job
 * still advances to "Application Ready" — a finished-looking application nobody tailored.
 * The note must be left exactly as it was so the click can just be repeated once Ollama is
 * back up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above every const in the file, so the spies they close over
// have to be created in a hoisted block too.
const { setJobStatus, setInterested, applicationAgent } = vi.hoisted(() => ({
  setJobStatus: vi.fn(),
  setInterested: vi.fn(),
  applicationAgent: vi.fn(),
}));

vi.mock("../src/vault.js", () => ({
  getJobNoteById: vi.fn().mockResolvedValue({
    file: "x.md",
    body: "## Description\n\nsome text\n",
    data: { id: "job-1", title: "ICT Field Services Technician", company: "Spark", url: "https://example.com/1", source: "seek" },
  }),
  setJobStatus,
  setInterested,
  setAppliedDate: vi.fn(),
}));
vi.mock("../src/agents/application.js", () => ({ applicationAgent }));
vi.mock("../src/convert.js", () => ({ convertBoth: vi.fn().mockResolvedValue({ files: [], errors: [] }) }));
import { markInterested } from "../src/workflow.js";
import { OLLAMA_MODEL } from "../src/llm.js";

/**
 * Drive the REAL gate rather than mocking it. `requireOllama` calls `ollamaAvailable`
 * through llm.js's own module binding, so replacing that export changes nothing — the
 * check would still hit the developer's live Ollama and pass. Stubbing fetch is what
 * actually exercises the code path, and it keeps the assertion on the real error text.
 */
function ollamaSays(up: boolean): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      if (!up) throw new Error("ECONNREFUSED");
      if (String(url).includes("/api/tags")) {
        return { ok: true, json: async () => ({ models: [{ model: OLLAMA_MODEL }] }) } as never;
      }
      // The unload call on the way out; it swallows everything anyway.
      return { ok: true, json: async () => ({}) } as never;
    }),
  );
}

beforeEach(() => {
  setJobStatus.mockReset();
  setInterested.mockReset();
  applicationAgent.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("markInterested — Ollama gate", () => {
  it("refuses when Ollama is not running", async () => {
    ollamaSays(false);
    const r = await markInterested("job-1");
    expect(r.ok).toBe(false);
  });

  it("tells the user to start the service", async () => {
    ollamaSays(false);
    const r = await markInterested("job-1");
    expect(r.message).toMatch(/Start the Ollama service/);
  });

  it("leaves the note untouched, so the click can simply be repeated", async () => {
    ollamaSays(false);
    await markInterested("job-1");
    expect(setJobStatus).not.toHaveBeenCalled();
    expect(setInterested).not.toHaveBeenCalled();
  });

  it("never reaches the tailoring agent", async () => {
    ollamaSays(false);
    await markInterested("job-1");
    expect(applicationAgent).not.toHaveBeenCalled();
  });

  it("proceeds normally when Ollama is up", async () => {
    ollamaSays(true);
    applicationAgent.mockResolvedValue({ tailored: true, reviewed: true, files: [] });
    const r = await markInterested("job-1");
    expect(r.ok).toBe(true);
    expect(setJobStatus).toHaveBeenCalledWith("job-1", "interested");
  });

  it("demands a real tailoring pass rather than accepting master copies", async () => {
    ollamaSays(true);
    applicationAgent.mockResolvedValue({ tailored: true, reviewed: true, files: [] });
    await markInterested("job-1");
    // The background task is not awaited by markInterested; let its first tick run.
    await new Promise((r) => setTimeout(r, 0));
    // Assert the option itself: the score argument is legitimately undefined for a note
    // that carries no fit yet, and expect.anything() does not match undefined.
    expect(applicationAgent.mock.calls[0]?.[3]).toEqual({ requireLlm: true });
  });
});
