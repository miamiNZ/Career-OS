/**
 * Bounded-concurrency helpers.
 *
 * Nearly every slow step in a run is latency-bound rather than CPU-bound — an SMB
 * round-trip per vault note, an HTTP call per listing, an Ollama call per job — so the
 * fix is always "run N of them at once", never "make one faster". Kept in one place so
 * the vault, the search agents and the orchestrator all use the same primitive.
 */

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Wrap an async factory so concurrent callers share one in-flight promise.
 *
 * Used for credentialed handshakes (the ZEIL Cognito SRP login): once searches run
 * several queries at once, N callers would otherwise each start their own login before
 * the first one finished caching its token. A rejected call is not cached, so the next
 * caller retries.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
