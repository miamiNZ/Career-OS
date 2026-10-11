/** Tests for src/concurrency.ts — the bounded-concurrency primitives. */
import { describe, it, expect } from "vitest";
import { mapLimit, singleFlight } from "../src/concurrency.js";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([30, 5, 20, 1], 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick(1);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("passes the index through", async () => {
    expect(await mapLimit(["a", "b"], 2, async (v, i) => `${i}:${v}`)).toEqual(["0:a", "1:b"]);
  });

  it("handles an empty list without spawning workers", async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
  });

  it("rejects if a worker throws — callers isolate per item themselves", async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("singleFlight", () => {
  it("shares one in-flight call between concurrent callers", async () => {
    let calls = 0;
    const get = singleFlight(async () => {
      calls++;
      await tick(5);
      return "token";
    });
    expect(await Promise.all([get(), get(), get()])).toEqual(["token", "token", "token"]);
    expect(calls).toBe(1);
  });

  it("calls again once the previous call has settled", async () => {
    let calls = 0;
    const get = singleFlight(async () => {
      calls++;
      return calls;
    });
    await get();
    await get();
    expect(calls).toBe(2);
  });

  it("does not cache a rejection — the next caller retries", async () => {
    let calls = 0;
    const get = singleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error("auth failed");
      return "token";
    });
    await expect(get()).rejects.toThrow("auth failed");
    expect(await get()).toBe("token");
  });
});
