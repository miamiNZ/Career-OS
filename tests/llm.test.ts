/**
 * Tests for src/llm.ts — context-window sizing. Ollama defaults num_ctx to 4096 and
 * truncates the FRONT of an over-long prompt, which silently strips the master resume out
 * of a tailoring call. These pin the sizing and that it reaches the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  contextFor,
  ollamaChat,
  requireOllama,
  unloadOllama,
  releaseOllamaIfIdle,
  OllamaUnavailableError,
  OLLAMA_MODEL,
} from "../src/llm.js";

describe("contextFor", () => {
  it("keeps the cheap 4k floor for a short scoring prompt", () => {
    // ~7000 chars of profile + job description, 300-token JSON reply.
    expect(contextFor(7000, 300)).toBe(4096);
  });

  it("sizes the real tailorSummary prompt without over-reserving", () => {
    // Measured from the vault: 1973-char system + 8935-char master body + summary +
    // an 8000-char job block, with a 2000-token thinking budget.
    expect(contextFor(19800, 2000)).toBe(9216);
  });

  it("sizes the real tailorCover prompt without over-reserving", () => {
    // sys 4304 + template 1198 + skills 2484 + experience 5597 + job block.
    expect(contextFor(21900, 4000)).toBe(12288);
  });

  it("rounds to 1024, not to the next power of two", () => {
    // The whole point: 8.8k tokens must not reserve a 16k window and 4GB of KV cache.
    expect(contextFor(19800, 2000)).toBeLessThan(16384);
    expect(contextFor(19800, 2000) % 1024).toBe(0);
  });

  it("clamps at 16k rather than reserving an unbounded window", () => {
    expect(contextFor(500_000, 2048)).toBe(16384);
  });

  it("never returns less than the generation budget it was given", () => {
    expect(contextFor(0, 2048)).toBeGreaterThan(2048);
  });
});

describe("ollamaChat num_ctx", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "hi" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0]![1].body);

  it("sends a num_ctx sized for the prompt", async () => {
    await ollamaChat("sys".repeat(100), "u".repeat(16000), { maxTokens: 400 });
    expect(bodyOf().options.num_ctx).toBe(6144);
  });

  it("does not send the 4k default for a prompt that exceeds it", async () => {
    await ollamaChat("s", "u".repeat(25000), { maxTokens: 1200 });
    expect(bodyOf().options.num_ctx).toBeGreaterThan(4096);
  });

  it("honours an explicit numCtx override", async () => {
    await ollamaChat("s", "u", { numCtx: 32768 });
    expect(bodyOf().options.num_ctx).toBe(32768);
  });

  it("leaves thinking off by default so scoring is not made to deliberate", async () => {
    await ollamaChat("s", "u");
    expect(bodyOf().think).toBe(false);
  });

  it("enables thinking when a tailoring call opts in", async () => {
    await ollamaChat("s", "u", { think: true, maxTokens: 2000 });
    expect(bodyOf().think).toBe(true);
  });

  it("grows the context window to cover a thinking call's larger budget", async () => {
    // 2000 tokens of reasoning + answer has to fit alongside the prompt, not evict it.
    const plain = contextFor(12000, 300);
    const thinking = contextFor(12000, 2000);
    expect(thinking).toBeGreaterThan(plain);
    await ollamaChat("s", "u".repeat(12000), { think: true, maxTokens: 2000 });
    expect(bodyOf().options.num_ctx).toBe(thinking);
  });

  it("retries without thinking when reasoning ate the whole budget", async () => {
    // qwen3:32b measurably does this: 600 tokens of reasoning, empty content.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "", thinking: "..." } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: "the answer" } }) });
    const out = await ollamaChat("s", "u", { think: true, maxTokens: 2000 });
    expect(out).toBe("the answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).think).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).think).toBe(false);
  });

  it("throws when even the non-thinking retry comes back empty", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ message: { content: "" } }) });
    await expect(ollamaChat("s", "u", { think: true })).rejects.toThrow("empty content");
  });

  it("does not retry a non-thinking call that returns nothing", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ message: { content: "" } }) });
    await expect(ollamaChat("s", "u")).rejects.toThrow("empty content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still sends num_predict alongside it", async () => {
    await ollamaChat("s", "u", { maxTokens: 300 });
    const opts = bodyOf().options;
    expect(opts.num_predict).toBe(300);
    expect(opts.num_ctx).toBe(4096);
  });
});

describe("requireOllama", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tags = (models) => ({ ok: true, json: async () => ({ models }) });

  it("passes when the service answers and the model is pulled", async () => {
    fetchMock.mockResolvedValue(tags([{ model: OLLAMA_MODEL }]));
    await expect(requireOllama("Scoring")).resolves.toBeUndefined();
  });

  it("throws OllamaUnavailableError when the service is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(requireOllama("Scoring")).rejects.toBeInstanceOf(OllamaUnavailableError);
  });

  it("throws when the service is up but the model is not pulled", async () => {
    fetchMock.mockResolvedValue(tags([{ model: "some-other-model:7b" }]));
    await expect(requireOllama("Scoring")).rejects.toBeInstanceOf(OllamaUnavailableError);
  });

  it("names the caller and tells the user how to start the service", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(requireOllama("Tailoring this application")).rejects.toThrow(
      /Tailoring this application.*ollama serve/s,
    );
  });

  it("says nothing was written, so a failed run is not mistaken for a partial one", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(requireOllama("Scoring")).rejects.toThrow(/Nothing has been scored or written/);
  });
});

describe("unloadOllama", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Ollama to evict the model immediately", async () => {
    await unloadOllama();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/generate");
    expect(body.keep_alive).toBe(0);
    expect(body.model).toBe(OLLAMA_MODEL);
  });

  it("never throws when the service is already gone", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(unloadOllama()).resolves.toBeUndefined();
  });

  it("unloads on release when nothing is in flight", async () => {
    await releaseOllamaIfIdle();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("leaves the model loaded while another call is still running", async () => {
    // Hold one chat open, then release: the in-flight call must keep the weights resident.
    let finish;
    fetchMock.mockImplementationOnce(
      () => new Promise((r) => { finish = () => r({ ok: true, json: async () => ({ message: { content: "hi" } }) }); }),
    );
    const pending = ollamaChat("s", "u");
    await Promise.resolve();
    fetchMock.mockClear();
    await releaseOllamaIfIdle();
    expect(fetchMock).not.toHaveBeenCalled();
    finish();
    await pending;
  });
});
