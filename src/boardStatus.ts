/**
 * Where a note lands on the board, and how many notes land in each place.
 *
 * Its own module because two separate things depend on agreeing exactly: the board screens
 * (which render the columns) and the nav badge counts (which claim how many are in them). A
 * badge that counts differently from the page it links to is worse than no badge — it tells
 * you to go look at something that isn't there, or hides something that is.
 */
import type { JobStatus } from "./types.js";

/** Columns shown on the board, in order. The full enum still exists for old notes. */
export const STATUS_ORDER: JobStatus[] = [
  "lead",
  "interested",
  "tailoring",
  "applied",
  "unsuccessful",
  "dropped",
];

/**
 * The status a note is displayed under. Notes carry whatever status was written when they
 * were last touched, including stages that have since been retired; anything unrecognised
 * folds back to "lead" so it stays visible and actionable rather than vanishing from every
 * screen. A retired "dropped"-like stage keeps its meaning instead.
 */
export function boardStatusOf(data: { status?: unknown }): JobStatus {
  const status = (data.status ?? "lead") as JobStatus;
  if (STATUS_ORDER.includes(status)) return status;
  return status === "dropped" ? "dropped" : "lead";
}

/** Tally notes into every board column, including the columns that end up empty. */
export function countByStatus(notes: { data: { status?: unknown } }[]): Record<JobStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const n of notes) counts[boardStatusOf(n.data)]++;
  return counts;
}
