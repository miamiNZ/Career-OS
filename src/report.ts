import fs from "node:fs/promises";
import path from "node:path";
import { vault } from "./config.js";
import type { Job, Score } from "./types.js";

/** Write a ranked markdown report of scored jobs into Career/Applications/. */
export async function writeReport(rows: { job: Job; score: Score }[]): Promise<string> {
  await fs.mkdir(vault.reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(vault.reportsDir, `report-${date}.md`);

  const ranked = [...rows].sort((a, b) => Number(a.score.rejected) - Number(b.score.rejected) || b.score.fit - a.score.fit);
  const keep = ranked.filter((r) => !r.score.rejected);
  const rejected = ranked.filter((r) => r.score.rejected);

  const line = (r: { job: Job; score: Score }) =>
    `| ${r.score.fit} | [${r.job.title}](${r.job.url}) | ${r.job.company ?? "—"} | ${r.job.location ?? "—"} | ${r.job.salaryText ?? "—"} | ${r.score.rationale.replace(/\|/g, "/")} |`;

  const body = [
    `---\ntype: report\ndate: ${date}\n---`,
    `# Job Report — ${date}`,
    "",
    `${keep.length} candidates · ${rejected.length} auto-rejected. **GATE 1:** set a job's note \`status: interested\` to pursue it.`,
    "",
    "## Candidates",
    "",
    "| Fit | Role | Company | Location | Salary | Why |",
    "|--:|---|---|---|---|---|",
    ...keep.map(line),
    "",
    "## Auto-rejected",
    "",
    "| Fit | Role | Company | Location | Salary | Reason |",
    "|--:|---|---|---|---|---|",
    ...rejected.map(line),
    "",
  ].join("\n");

  await fs.writeFile(file, body, "utf8");
  return file;
}
