/**
 * Local LLM via Ollama. Used for tailoring resumes + cover letters.
 * No API key, no cloud — everything runs against OLLAMA_URL (default localhost:11434).
 */

import { vlog } from "./logbus.js";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:32b";

/**
 * Model used for job scoring, which is a short classification on a long prompt and is run
 * once per job — a search run scores hundreds. The writing model is sized for tailoring
 * resumes and cover letters, where quality matters and there are only ever two calls; at
 * 32B it spends ~55s per job, turning one run into hours.
 *
 * Pointing this at a smaller model is tempting but is NOT free, and the cost is invisible:
 * scoring decides what clears `min_fit_to_keep` and reaches the board at all, so a weaker
 * scorer does not merely rank differently — it buries jobs you never see. Measured against
 * qwen3:32b over 20 real vault jobs, qwen3:8b moved 5 of them across the threshold (mean
 * delta 16.6 points), systematically inflating obvious senior-dev titles and crushing
 * everything else. Validate any candidate with `scripts/score-agreement.ts` before trusting
 * it. Defaults to OLLAMA_MODEL so nothing changes until it's set.
 */
export const OLLAMA_SCORE_MODEL = process.env.OLLAMA_SCORE_MODEL || OLLAMA_MODEL;

export interface OllamaOptions {
  /** Lower = more deterministic. Default 0.4 for grounded, factual writing. */
  temperature?: number;
  /** Soft cap on generated tokens. */
  maxTokens?: number;
  /** Constrain output to valid JSON (Ollama `format: "json"`). */
  json?: boolean;
  /** Override the model for this call. Defaults to OLLAMA_MODEL. */
  model?: string;
  /** Override the context window. Defaults to a size derived from the prompt. */
  numCtx?: number;
  /** Override the request timeout. Defaults to a budget derived from maxTokens. */
  timeoutMs?: number;
  /**
   * Let a reasoning model deliberate before answering. Off by default: scoring runs
   * hundreds of times per run and a JSON verdict does not need it. Worth it for tailoring,
   * where the model has to pick which master-resume facts match the job before writing —
   * the step that keeps it from inventing skills. Costs 2-3x the generated tokens, so any
   * caller enabling it must raise maxTokens to cover the reasoning AND the answer.
   */
  think?: boolean;
}

/**
 * Ollama defaults `num_ctx` to 4096 and, when a prompt exceeds it, silently drops the
 * OLDEST tokens — which for tailoring is the master resume the model is supposed to stay
 * grounded in. A summary prompt (whole master + an 8000-char job block) clears 4096 easily,
 * so the model was being asked to re-angle a resume it could only half see. Size the window
 * from the actual prompt instead of trusting the default.
 */
const CTX_MIN = 4096;
const CTX_MAX = 16384;

/**
 * Smallest window that holds the prompt plus the generation budget, rounded up to 1024.
 *
 * Every reserved token costs KV cache in VRAM — ~256KB/token on qwen3:32b, so a 16k window
 * is 4GB of an 8GB card and shoves model weights back onto the CPU. Rounding to 1024 rather
 * than to the next power of two matters: the real tailoring prompt needs ~8.8k tokens, which
 * a power-of-two bucket would round to 16384 and nearly double the cache for nothing.
 *
 * Counts ~3.5 chars per token (English prose with code and punctuation) and pads 20% so an
 * undercount still fits. Scoring — short prompt, 300-token reply — stays at the 4k floor.
 */
export function contextFor(promptChars: number, maxTokens: number): number {
  const needed = Math.ceil((promptChars / 3.5) * 1.2) + maxTokens;
  const rounded = Math.ceil(needed / 1024) * 1024;
  return Math.min(Math.max(rounded, CTX_MIN), CTX_MAX);
}

/**
 * Thrown when Ollama is not reachable (or the model is not pulled) and the caller cannot
 * proceed without it. A distinct type so callers can tell "the LLM is down, tell the user
 * to start it" apart from "the model returned something unusable", which is retryable.
 */
export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

/**
 * Hard gate. Scoring and tailoring are the only things that decide what reaches the board
 * and what gets written into an application, and both have a silent degraded path — a
 * keyword heuristic for scoring, untailored master copies for tailoring. Degrading quietly
 * is worse than stopping: the run "succeeds", the numbers look normal, and the board fills
 * with fit scores no model ever produced. Stop instead, and say exactly what to do.
 */
export async function requireOllama(purpose: string): Promise<void> {
  if (await ollamaAvailable()) return;
  throw new OllamaUnavailableError(
    `${purpose} needs the local LLM, but Ollama is not answering at ${OLLAMA_URL} ` +
      `(or the model "${OLLAMA_MODEL}" is not pulled). Nothing has been scored or written. ` +
      `Start the Ollama service — open the Ollama app, or run "ollama serve" — then ` +
      `"make ollama-pull" if the model is missing, and try again.`,
  );
}

/**
 * Model calls currently in flight. An unload must never fire while one is running: Ollama
 * would evict the weights mid-generation and the next call pays a full reload.
 */
let inFlight = 0;

/**
 * Tell Ollama to drop the model from memory now.
 *
 * Ollama keeps a model resident for `keep_alive` (5 minutes by default) after the last
 * request, so a finished run leaves ~15GB of qwen3:32b sitting in RAM/VRAM with every task
 * on the Activity screen showing "done". A zero `keep_alive` is the documented way to
 * evict it. Both the writing model and the scoring model are unloaded — they are usually
 * the same, but need not be.
 */
export async function unloadOllama(): Promise<void> {
  const models = [...new Set([OLLAMA_MODEL, OLLAMA_SCORE_MODEL])];
  await Promise.all(
    models.map(async (model) => {
      try {
        await fetch(`${OLLAMA_URL}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        });
        vlog(`[llm] unloaded ${model} from memory`);
      } catch (e) {
        // Freeing memory is a courtesy, never a reason to fail work that already succeeded.
        vlog(`[llm] could not unload ${model}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
}

/**
 * Unload only if nothing else is mid-call. Callers invoke this when their own work is done;
 * a second task still generating keeps the model resident, and unloads when IT finishes.
 */
export async function releaseOllamaIfIdle(): Promise<void> {
  if (inFlight > 0) {
    vlog(`[llm] ${inFlight} call(s) still running — leaving the model loaded`);
    return;
  }
  await unloadOllama();
}

/** True if an Ollama server is reachable and the target model is pulled. */
export async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data: any = await res.json();
    const names: string[] = (data.models ?? []).map((m: any) => String(m.model ?? m.name));
    return names.some((n) => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL.split(":")[0] ?? ""));
  } catch {
    return false;
  }
}

/**
 * One-shot chat completion. Throws if Ollama is unreachable or errors.
 *
 * With `think` on, a verbose reasoner can spend the whole num_predict budget deliberating
 * and return an empty answer (measured: qwen3:32b burned 600 tokens of reasoning on a
 * one-sentence rewrite). Rather than let that surface as a failed tailoring call, retry once
 * with thinking off — the slower, better answer is an upgrade when it lands and the plain
 * answer is exactly what the caller used to get when it does not.
 */
export async function ollamaChat(
  system: string,
  user: string,
  opts: OllamaOptions = {},
): Promise<string> {
  const out = await ollamaChatOnce(system, user, opts);
  if (out !== null) return out;
  if (opts.think) {
    vlog("[llm] thinking consumed the whole token budget — retrying without it");
    const plain = await ollamaChatOnce(system, user, { ...opts, think: false });
    if (plain !== null) return plain;
  }
  throw new Error("Ollama returned empty content");
}

/** Single call. Returns null when the model produced no answer, so the caller can retry. */
async function ollamaChatOnce(
  system: string,
  user: string,
  opts: OllamaOptions = {},
): Promise<string | null> {
  const maxTokens = opts.maxTokens ?? 2048;
  const promptChars = system.length + user.length;
  const numCtx = opts.numCtx ?? contextFor(promptChars, maxTokens);
  const timeoutMs = opts.timeoutMs ?? 120_000 + Math.ceil(maxTokens / 3) * 1000;
  // Even the largest window can be overrun. Say so rather than let the front of the prompt
  // vanish without a trace.
  const estimated = Math.ceil(promptChars / 3.5) + maxTokens;
  if (estimated > numCtx) {
    vlog(
      `[llm] prompt ~${Math.ceil(promptChars / 3.5)} tok + ${maxTokens} predict > num_ctx ${numCtx} — Ollama will truncate the front of the prompt`,
    );
  }
  inFlight++;
  try {
    return await postChat(system, user, { maxTokens, numCtx, timeoutMs, ...opts });
  } finally {
    inFlight--;
  }
}

/** The actual HTTP call, split out so the in-flight counter above is exception-safe. */
async function postChat(
  system: string,
  user: string,
  opts: OllamaOptions & { maxTokens: number; numCtx: number; timeoutMs: number },
): Promise<string | null> {
  const { maxTokens, numCtx, timeoutMs } = opts;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model || OLLAMA_MODEL,
      stream: false,
      // num_predict covers reasoning AND answer, so a thinking model with a tight budget
      // spends it all deliberating and returns an empty/truncated answer. Default off;
      // callers that opt in budget for both. Ollama ignores this for non-reasoning models.
      think: opts.think ?? false,
      ...(opts.json ? { format: "json" } : {}),
      options: {
        temperature: opts.temperature ?? 0.4,
        num_predict: maxTokens,
        num_ctx: numCtx,
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    // The timeout has to scale with what we asked the model to WRITE. A flat 5 minutes was
    // fine for a 400-token summary but silently killed every thinking call: qwen3:32b runs
    // ~4.7 tok/s here with most of the model offloaded to CPU, so a 4000-token budget needs
    // ~14 minutes and was aborting at 5 — burning the full timeout and then falling back to
    // untailored output, which is worse than not trying. Budget 3 tok/s (a margin under the
    // measured rate) plus 120s for model load and prompt eval.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const data: any = await res.json();
  const content = data?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}
