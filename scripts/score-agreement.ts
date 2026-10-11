/**
 * Throwaway harness: does a smaller scoring model agree with the qwen3:32b fits already
 * recorded in the vault? Splitting OLLAMA_SCORE_MODEL off from OLLAMA_MODEL is only safe if
 * the small model keeps jobs on the same side of min_fit_to_keep — a disagreement that does
 * not cross the threshold costs nothing, one that does silently buries a real opportunity.
 *
 *   npx cross-env UV_THREADPOOL_SIZE=64 tsx scripts/score-agreement.ts qwen3:8b 20
 */
import { loadProfile, listJobNotes, type JobNote } from "../src/vault.js";
import { profileDigest, profileFingerprint } from "../src/profile.js";
import { ollamaChat } from "../src/llm.js";
import { SCORE_SYS } from "../src/score.js";
import { loadSearchConfig } from "../src/searchConfig.js";

const MODEL = process.argv[2] ?? "qwen3:8b";
const SAMPLE = Number(process.argv[3] ?? 20);

async function scoreWith(model: string, digest: string, n: JobNote): Promise<number | null> {
  const user = `CANDIDATE PROFILE:\n${digest}\n\nJOB:\nTitle: ${n.data.title}\nCompany: ${n.data.company ?? ""}\nLocation: ${n.data.location ?? ""}\nDescription:\n${(n.body || "").slice(0, 5000)}`;
  try {
    const raw = await ollamaChat(SCORE_SYS, user, { json: true, temperature: 0.1, maxTokens: 300, model });
    const fit = Math.round(Number(JSON.parse(raw).fit));
    return Number.isFinite(fit) ? Math.max(0, Math.min(100, fit)) : null;
  } catch (e) {
    console.warn(`  ! ${n.data.title}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const profile = await loadProfile();
const digest = profileDigest(profile);
const hash = profileFingerprint(digest);
const cfg = await loadSearchConfig();
const threshold = cfg.minFitToKeep;

const notes = await listJobNotes();
// Only notes scored against THIS profile are comparable; a fit from an older profile
// version would make the small model look wrong for the wrong reason.
const comparable = notes.filter(
  (n) => typeof n.data.fit === "number" && n.data.profileHash === hash && (n.body || "").length > 200,
);
console.log(`${notes.length} notes, ${comparable.length} scored against the current profile (hash ${hash.slice(0, 8)})`);
if (!comparable.length) {
  console.log("Nothing comparable — the profile changed since the last scoring run. Re-run `npm run rescore` first.");
  process.exit(0);
}

// Stratify across the fit range so the sample is not all one kind of job.
const byFit = [...comparable].sort((a, b) => a.data.fit - b.data.fit);
const step = Math.max(1, Math.floor(byFit.length / SAMPLE));
const sample = byFit.filter((_, i) => i % step === 0).slice(0, SAMPLE);

console.log(`\nScoring ${sample.length} jobs with ${MODEL}, comparing to recorded qwen3:32b fits (min_fit_to_keep=${threshold})\n`);
console.log("  32b   new   Δ     flip  title");
const deltas: number[] = [];
let flips = 0;
const t0 = Date.now();
for (const n of sample) {
  const was = n.data.fit as number;
  const now = await scoreWith(MODEL, digest, n);
  if (now === null) continue;
  const d = now - was;
  deltas.push(Math.abs(d));
  const flipped = was >= threshold !== now >= threshold;
  if (flipped) flips++;
  console.log(
    `  ${String(was).padStart(3)}   ${String(now).padStart(3)}   ${(d >= 0 ? "+" : "") + d}`.padEnd(24) +
      `${flipped ? (now < threshold ? "LOST " : "GAIN ") : "  .  "} ${String(n.data.title).slice(0, 60)}`,
  );
}
const secs = (Date.now() - t0) / 1000;
const mean = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
const within10 = deltas.filter((d) => d <= 10).length;
console.log(`\n  n=${deltas.length}  mean |Δ|=${mean.toFixed(1)}  within 10pts=${within10}/${deltas.length}`);
console.log(`  threshold flips: ${flips}/${deltas.length}  (jobs that would change Kept/Dropped)`);
console.log(`  ${(secs / deltas.length).toFixed(1)}s per job with ${MODEL}\n`);
