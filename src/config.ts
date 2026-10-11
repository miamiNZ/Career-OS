import "dotenv/config";
import path from "node:path";
import type { HardFilters } from "./types.js";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Model for the cheap Claude calls (job scoring + resume keyword/query extraction).
  // Defaults to Haiku for ~5x lower cost; set SCORING_MODEL=claude-opus-4-8 for max quality.
  // `||` not `??`: SCORING_MODEL is commonly present-but-blank in .env, and an empty
  // model id makes every Anthropic call 404 rather than falling back.
  scoringModel: process.env.SCORING_MODEL || "claude-haiku-4-5",
  // USD->NZD rate for the dashboard cost estimate (override as the rate moves).
  usdToNzd: Number(process.env.USD_TO_NZD ?? 1.67),
  vaultPath: req("VAULT_PATH"),

  // When the server runs in a container, its vault path (VAULT_PATH, e.g. /vault) is
  // meaningless to the browser's machine. Set REVEAL_HOST_PATH to the location the
  // vault maps to as seen from your desktop — e.g. an SMB share such as
  //   \\nas\appdata\obsidian\MyVault
  // and "Show files" returns the per-application path under it for you to open.
  revealHostPath: process.env.REVEAL_HOST_PATH ?? "",

  ingestSource: (process.env.INGEST_SOURCE ?? "file") as "graph" | "imap" | "file",

  graph: {
    clientId: process.env.GRAPH_CLIENT_ID ?? "",
    tenantId: process.env.GRAPH_TENANT_ID ?? "",
    clientSecret: process.env.GRAPH_CLIENT_SECRET ?? "",
    mailFolder: process.env.GRAPH_MAIL_FOLDER ?? "JobAlerts",
  },
  imap: {
    host: process.env.IMAP_HOST ?? "outlook.office365.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    user: process.env.IMAP_USER ?? "",
    password: process.env.IMAP_PASSWORD ?? "",
    folder: process.env.IMAP_FOLDER ?? "JobAlerts",
  },

  // Dev: drop .eml/.txt alert files here for INGEST_SOURCE=file. Override with INBOX_DIR.
  inboxDir: path.resolve(process.env.INBOX_DIR ?? "inbox"),

  // ZEIL job-seeker login. ZEIL has no anonymous access, so search needs your account
  // (sign in via Cognito SRP to mint a short-lived token). Leave blank to disable ZEIL.
  zeil: {
    email: process.env.ZEIL_EMAIL ?? "",
    password: process.env.ZEIL_PASSWORD ?? "",
  },
} as const;

/** Vault sub-paths, derived from VAULT_PATH. */
export const vault = {
  root: config.vaultPath,
  profileDir: path.join(config.vaultPath, "Career", "Profile"),
  jobsDir: path.join(config.vaultPath, "Career", "Jobs"),
  // Tailored resumes + cover letters live under the Jobs folder, per the vault layout.
  applicationsDir: path.join(config.vaultPath, "Career", "Jobs", "Applications"),
  resumeMaster: path.join(config.vaultPath, "Career", "Resume", "resume-master.md"),
  coverLetterTemplate: path.join(
    config.vaultPath,
    "Career",
    "Supporting",
    "cover-letter-template.md",
  ),
  // The candidate's own wording for the deterministic cover letter (see application.ts).
  coverLetterFallback: path.join(config.vaultPath, "Career", "Profile", "cover-letter-fallback.md"),
  jobTemplate: path.join(config.vaultPath, "Career", "Jobs", "_template.md"),
  // Applied/Unsuccessful notes cleared off the board are moved here. The vault scan
  // reads Career/Jobs non-recursively, so a sub-folder is invisible to the board while
  // the notes themselves (and their generated documents) stay in the vault.
  archiveDir: path.join(config.vaultPath, "Career", "Jobs", "Archive"),
  // Durable record of every role you applied for, kept independently of the notes so
  // clearing the board never re-opens a role to search. See vault.readAppliedHistory.
  appliedHistory: path.join(config.vaultPath, "Career", "applied-history.json"),
  tracker: path.join(config.vaultPath, "Career", "Applications", "tracker.md"),
  reportsDir: path.join(config.vaultPath, "Career", "Applications"),
  // Obsidian "Contacts" folder (backed by Contacts.base) — recruiter/hiring contacts
  // extracted from job ads land here as `type: contact` notes.
  contactsDir: path.join(config.vaultPath, "Career", "Contacts"),
  // Dashboard filter presets, stored in the vault so they sync across machines.
  dashboardPresets: path.join(config.vaultPath, "Career", "dashboard-presets.json"),
} as const;

/**
 * Hard-filter defaults. Each user's own values live in the frontmatter of
 * Career/Profile/preferences.md (`min_salary`, `reject_if_citizenship_required`) and are
 * applied per run by hardFiltersFor() in score.ts. The defaults reject nothing, so a vault
 * that sets neither still sees every role.
 */
export const hardFilters: HardFilters = {
  // Ads whose parsed maximum falls below this are auto-rejected. Only a PARSED maximum
  // counts — "Negotiable" / unstated salary is never rejected on this rule. 0 = off.
  minSalary: 0,
  // Off: citizenship / security-clearance roles are let through and judged on fit.
  rejectIfCitizenshipRequired: false,
  preferredEngagement: "permanent",
};
