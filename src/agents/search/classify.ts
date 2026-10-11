import type { Job } from "../../types.js";

/** Decode the common HTML entities that leak into titles/company names from search APIs. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

type EmploymentType = Job["employmentType"];
type WorkArrangement = Job["workArrangement"];

/**
 * Normalise the many ways the three sites label a job's employment type.
 * Seek: "Full time" · TradeMe: "FT"/"PT"/"C" · LinkedIn: free text.
 */
export function mapEmploymentType(raw: unknown): EmploymentType {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return "unknown";
  if (/(^|\b)(ft|full)\b|full[\s-]?time/.test(s)) return "full-time";
  if (/(^|\b)(pt)\b|part[\s-]?time/.test(s)) return "part-time";
  if (/(^|\b)(c|ct)\b|contract|fixed[\s-]?term|temp/.test(s)) return "contract";
  if (/casual/.test(s)) return "casual";
  return "unknown";
}

/**
 * Work arrangement from an explicit label (Seek gives "Remote"/"Hybrid"/"On-site")
 * or, failing that, a heuristic scan of the job title + description.
 */
export function detectWorkArrangement(label: unknown, text = ""): WorkArrangement {
  const l = String(label ?? "").toLowerCase();
  if (/remote/.test(l)) return "remote";
  if (/hybrid/.test(l)) return "hybrid";
  if (/on[\s-]?site|office/.test(l)) return "onsite";

  const t = text.toLowerCase();
  if (/\bfully remote\b|\b100% remote\b|\bwork from home\b|\bwfh\b|\bremote (role|work|position|first)\b/.test(t))
    return "remote";
  if (/\bhybrid\b/.test(t)) return "hybrid";
  return "unknown";
}
