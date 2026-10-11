import { z } from "zod";

export type JobStatus =
  | "lead"
  | "interested"
  | "tailoring"
  | "applied"
  | "unsuccessful"
  | "interview"
  | "offer"
  | "rejected"
  | "dropped";

export type Engagement = "permanent" | "contract" | "unknown";

/**
 * One role you applied for, recorded permanently — independent of whether its note is
 * still on the board.
 *
 * The search run excludes a role you've already applied to by indexing the Applied /
 * Unsuccessful notes, so clearing those columns used to make every one of those roles
 * eligible again on the next run. This ledger is what survives the clearing: the same
 * url / title+company identity the index is built from, written once when the note is
 * archived and never removed.
 */
export interface AppliedHistoryEntry {
  id: string;
  title: string;
  company?: string;
  url?: string;
  source?: string;
  /** The status the note carried when it was archived. */
  status: "applied" | "unsuccessful";
  /** Date the user recorded applying (YYYY-MM-DD), when the note had one. */
  applied?: string;
  /** ISO timestamp of when the note was cleared off the board. */
  archivedAt: string;
}

/** A normalized job opportunity, parsed from an alert email. */
export const JobSchema = z.object({
  id: z.string(), // stable hash of source+url
  source: z.enum(["seek", "linkedin", "trademe", "indeed", "zeil", "other"]),
  title: z.string(),
  company: z.string().optional(),
  location: z.string().optional(),
  url: z.string().url(),
  salaryText: z.string().optional(), // raw, e.g. "$110k - $130k"
  salaryMin: z.number().optional(), // parsed NZD/yr
  salaryMax: z.number().optional(),
  engagement: z.enum(["permanent", "contract", "unknown"]).default("unknown"),
  employmentType: z
    .enum(["full-time", "part-time", "contract", "casual", "unknown"])
    .default("unknown"),
  workArrangement: z.enum(["remote", "hybrid", "onsite", "unknown"]).default("unknown"),
  description: z.string().default(""),
  postedAt: z.string().optional(), // ISO — when the listing went live
  closesAt: z.string().optional(), // ISO — when the listing expires/closes
  expired: z.boolean().optional(), // true = re-fetch confirmed the listing is gone/closed
  ingestedAt: z.string(), // ISO
});
export type Job = z.infer<typeof JobSchema>;

/** Result of scoring a job against the user's Profile. */
export interface Score {
  jobId: string;
  fit: number; // 0-100
  rejected: boolean;
  rejectReasons: string[]; // hard-filter hits
  matchedSkills: string[];
  missingSkills: string[];
  rationale: string; // 1-2 line summary for the report
  /**
   * Which candidate profile and which scorer produced this number. A run only scores
   * jobs it hasn't scored before, so without a stamp the board mixes fits computed
   * against an older resume (or a different model) with fresh ones and there is no way
   * to tell which is which. `rescore --stale` re-runs exactly the mismatched notes.
   */
  profileHash?: string; // profileFingerprint() of the digest the job was scored against
  scorer?: string; // model id, or "heuristic" for the keyword fallback
}

/** The user's profile, loaded from the vault Profile/ folder. */
export interface Profile {
  skills: string;
  experience: string;
  education: string;
  preferences: string;
  resumeMaster: string;
  coverLetterTemplate: string;
  /**
   * The candidate's own wording for the deterministic cover letter
   * (Career/Profile/cover-letter-fallback.md). Optional: without it a generic body is used.
   */
  coverFallback?: string;
}

/** Hard filters applied before/independent of AI scoring. */
export interface HardFilters {
  minSalary: number; // NZD/yr
  rejectIfCitizenshipRequired: boolean;
  preferredEngagement: Engagement;
}

/** Outcome of one ingest→score→report run (returned to the scheduler + dashboard). */
export interface PipelineSummary {
  ranAt: string; // ISO
  ingested: number; // new job notes written
  found: number; // unique jobs returned by search this run
  enriched: number; // jobs whose full description was fetched from the listing url
  scored: number; // jobs scored this run
  kept: number; // passed hard filters
  rejected: number; // auto-rejected by hard filters
  /** Listings the run refused or dropped because the board already held the role. */
  duplicates: number;
  reportFile: string | null; // path to the written report, or null if nothing new
}
