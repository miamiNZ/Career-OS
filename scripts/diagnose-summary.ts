/**
 * Why did tailorSummary's draft get rejected? Runs the real summary prompt against a real
 * vault job twice — thinking on and thinking off — and reports the draft plus exactly which
 * guards each one trips. Thinking was enabled on 2026-08-31; this says whether it is the
 * cause of a rejection or merely present when one happens.
 *
 *   npx tsx scripts/diagnose-summary.ts [match-in-title]
 */
import { loadProfile, listJobNotes } from "../src/vault.js";
import { ollamaChat } from "../src/llm.js";
import { SUMMARY_SYS, extractSection, failedGuards } from "../src/agents/application.js";

const needle = (process.argv[2] ?? "").toLowerCase();

const profile = await loadProfile();
const masterBody = profile.resumeMaster ?? "";
const masterSummary = extractSection(masterBody, "Professional Summary");

const notes = await listJobNotes();
const note =
  notes.find((n) => needle && String(n.data.title ?? "").toLowerCase().includes(needle)) ??
  notes.filter((n) => typeof n.data.fit === "number" && (n.body ?? "").length > 400)
       .sort((a, b) => (b.data.fit as number) - (a.data.fit as number))[0];
if (!note) { console.log("no usable job note found"); process.exit(1); }

console.log(`job:    ${note.data.title} @ ${note.data.company ?? "?"} (recorded fit ${note.data.fit})`);
console.log(`master: ${masterBody.length} chars, summary section ${masterSummary.length} chars\n`);

const user =
  `MASTER RESUME (for grounding — use only facts from here):\n${masterBody}\n\n` +
  `MASTER SUMMARY (the paragraph to re-angle):\n${masterSummary || "(none)"}\n\n` +
  `JOB:\nTitle: ${note.data.title}\nCompany: ${note.data.company ?? ""}\nLocation: ${note.data.location ?? ""}\n` +
  `Description:\n${(note.body ?? "").slice(0, 8000)}`;

for (const [label, opts] of [
  ["THINKING ON  (current)", { maxTokens: 2000, temperature: 0.3, think: true }],
  ["THINKING OFF (previous)", { maxTokens: 400, temperature: 0.3, think: false }],
] as const) {
  const t0 = Date.now();
  let draft: string;
  try {
    draft = await ollamaChat(SUMMARY_SYS, user, opts);
  } catch (e) {
    console.log(`\n=== ${label} ===\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const clean = draft
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "")
    .replace(/^\s*#+.*$/gm, "").replace(/^\s*[-*+]\s+/gm, "")
    .trim();
  const failed = failedGuards(clean, masterBody);
  console.log(`\n=== ${label} ===  ${((Date.now() - t0) / 1000).toFixed(0)}s, ${clean.length} chars`);
  console.log(failed.length ? `REJECTED: ${failed.join(", ")}` : "ACCEPTED");
  console.log(`---\n${clean}\n---`);
}
