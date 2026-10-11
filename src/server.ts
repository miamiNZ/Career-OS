import "reflect-metadata";
import http from "node:http";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  listJobNotes,
  getJobNoteById,
  latestReport,
  reconcileApplications,
  expireClosedJobs,
  flagExpiredApplied,
  getApplicationDocs,
  getApplicationDir,
  listApplicationFiles,
  resolveApplicationFile,
  dedupeNoteFilesById,
  readPresets,
  writePresets,
  readAppliedHistory,
} from "./vault.js";
import { runNow, getSchedulerState, startScheduler, setSchedule, stopScheduler } from "./scheduler.js";
import { reenrichDescriptions, scanAppliedExpiry, dedupeLinkedInAgainstSeek, dedupeOpportunities, type SearchOverrides } from "./orchestrator.js";
import { markInterested, markApplied, dropJob, setStatus, nextStatuses } from "./workflow.js";
import { decodeEntities } from "./agents/search/classify.js";
import { convertApplicationDoc, type DocKind, type DocFormat } from "./convert.js";
import { ollamaAvailable, OLLAMA_MODEL, OLLAMA_URL } from "./llm.js";
import { installLogBus, getLogs, clearLogs, log } from "./logbus.js";
import { getRunProgress, type RunProgress } from "./runProgress.js";
import { listTasks, cancelTask, dismissTask, type Task } from "./activity.js";
import { STATUS_ORDER as BOARD_STATUS_ORDER, boardStatusOf, countByStatus } from "./boardStatus.js";
import { config } from "./config.js";
import type { JobStatus } from "./types.js";

// Mirror console.* into the in-memory log bus for the dashboard LOGS panel.
installLogBus();

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
// Bind host. Defaults to loopback-only (local tool, never on the network). In a
// container set DASHBOARD_HOST=0.0.0.0 and publish the port to 127.0.0.1 on the
// host (see the Makefile docker-* targets) so it stays local-only end to end.
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";

// App version, read once from package.json (two levels up from src/).
const APP_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();

/** Board columns + the status fold live in boardStatus.ts so the nav counts cannot drift. */
const STATUS_ORDER = BOARD_STATUS_ORDER;
const ALL_STATUSES: JobStatus[] = [
  "lead",
  "interested",
  "tailoring",
  "applied",
  "unsuccessful",
  "interview",
  "offer",
  "rejected",
  "dropped",
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Content types for downloadable application files (resume/cover-letter markdown + docx/pdf).
const DOWNLOAD_MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

/**
 * Ollama's reachability check is a 3s-timeout HTTP call, and /api/state ran it on every
 * poll — so with Ollama down the board paid 3s per refresh just to draw the same badge.
 * Cache the answer briefly; it only drives a status pill.
 */
const OLLAMA_CHECK_TTL_MS = 30_000;
let ollamaUp = { at: 0, up: false };
async function ollamaUpCached(): Promise<boolean> {
  if (Date.now() - ollamaUp.at < OLLAMA_CHECK_TTL_MS) return ollamaUp.up;
  ollamaUp = { at: Date.now(), up: await ollamaAvailable() };
  return ollamaUp.up;
}

/**
 * Send JSON, gzipped when the client accepts it. The board state is a few hundred KB of
 * highly repetitive JSON (every job on every column), fetched every 30s — compressing it
 * cuts the transfer by ~10x, which is what a phone on the far end feels.
 */
function json(res: http.ServerResponse, code: number, obj: unknown, req?: http.IncomingMessage): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const accepts = String(req?.headers["accept-encoding"] ?? "").includes("gzip");
  if (accepts && body.length > 1024) {
    const gz = gzipSync(body);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": gz.length,
    });
    return void res.end(gz);
  }
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}

const VALID_SITES = ["seek", "trademe", "linkedin", "indeed", "zeil"];

/** Build validated search overrides from a /api/run body's `overrides` object, so a
 *  saved dashboard filter can steer the search. Unknown/invalid values are dropped. */
function parseOverrides(body: any): SearchOverrides {
  const o = (body && body.overrides) || {};
  const out: SearchOverrides = {};
  if (Array.isArray(o.sites)) {
    const sites = o.sites.filter((s: unknown): s is "seek" | "trademe" | "linkedin" | "indeed" | "zeil" =>
      typeof s === "string" && VALID_SITES.includes(s));
    if (sites.length) out.sites = sites;
  }
  if (["full-time", "part-time", "any"].includes(o.employmentType)) out.employmentType = o.employmentType;
  if (["permanent", "contract", "any"].includes(o.engagement)) out.engagement = o.engagement;
  if (typeof o.keywords === "string" && o.keywords.trim()) out.keywords = o.keywords.trim();
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

async function serveStatic(res: http.ServerResponse, name: string): Promise<void> {
  try {
    const buf = await fs.readFile(path.join(WEB_DIR, name));
    res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

/**
 * Just the per-status tallies plus how much work is in flight — what the nav badges need.
 *
 * Deliberately NOT /api/state: that reconciles application folders, expires closed jobs and
 * serializes every job on the board. The nav is on every page and polls, so it gets a read
 * that only counts.
 */
async function buildCounts() {
  const counts = countByStatus(await listJobNotes());
  const run = getRunProgress();
  const active = listTasks().filter((t) => t.state === "running" || t.state === "queued").length;
  return { counts, activity: active + (run.running ? 1 : 0) };
}

/** The full dashboard state: jobs grouped by status + scheduler + latest report. */
async function buildState() {
  // Reflect any application folders the user deleted in Obsidian before reading.
  await reconcileApplications();
  // Auto-drop any active (lead/interested/tailoring) job whose closing date has passed.
  await expireClosedJobs();
  // Applied jobs stay put, but flag any whose listing has since closed (offline, date-based).
  await flagExpiredApplied();
  const notes = await listJobNotes();
  // Companies you've already applied to, normalized. Used to flag Opportunities for a
  // company you've already sent an application to. Drawn from the Applied notes AND the
  // applied-history ledger, so clearing the Applied column doesn't lose the flag.
  const appliedCompanies = new Set<string>();
  for (const n of notes) {
    if (n.data.status === "applied" && n.data.company) appliedCompanies.add(normCompany(String(n.data.company)));
  }
  for (const e of await readAppliedHistory()) {
    if (e.company) appliedCompanies.add(normCompany(e.company));
  }
  const jobs = notes.map((n) => {
    const status = boardStatusOf(n.data);
    const company = decodeEntities(String(n.data.company || ""));
    return {
      id: String(n.data.id ?? ""),
      title: decodeEntities(String(n.data.title ?? "(untitled)")),
      company,
      // True when you've already applied to this company (and this isn't the applied
      // row itself) — surfaced as a flag on the board so you don't re-apply.
      appliedToCompany: status !== "applied" && !!company && appliedCompanies.has(normCompany(company)),
      location: n.data.location || "",
      url: n.data.url || "",
      salary: n.data.salary || "",
      source: n.data.source || "",
      status,
      fit: typeof n.data.fit === "number" ? n.data.fit : null,
      band: rankBand(n.data),
      matchedCount: Array.isArray(n.data.matched) ? n.data.matched.length : 0,
      employmentType: (n.data.employmentType as string) || "unknown",
      engagement: (n.data.engagement as string) || "unknown",
      workArrangement: (n.data.workArrangement as string) || "unknown",
      autoRejected: !!n.data.autoRejected,
      interested: !!n.data.interested,
      applied: n.data.applied || null,
      posted: n.data.posted || null,
      closes: n.data.closes || null,
      expired: !!n.data.expired,
      // Which extra track found this, when one did ("local-it", "courier"). These are
      // scored against a senior-developer CV and are meant to rank low, so without a tag
      // saying where they came from a local IT role is indistinguishable on the board
      // from an off-target national one that scored the same.
      track: n.data.track || null,
      // Why an automatic drop happened, so a de-duped card doesn't read as your decision.
      dropReason: n.data.dropReason || null,
      duplicateOf: n.data.duplicateOf || null,
      rationale: n.data.rationale || "",
      summary: snippet(n.body),
      scored: n.data.scored || null,
      ingested: n.data.ingested || null,
      next: nextStatuses(status),
    };
  });

  type BoardJob = (typeof jobs)[number];
  const board = Object.fromEntries(ALL_STATUSES.map((s) => [s, [] as BoardJob[]])) as Record<JobStatus, BoardJob[]>;
  for (const j of jobs) board[j.status].push(j);
  for (const s of ALL_STATUSES) {
    board[s].sort(
      (a, b) => Number(a.autoRejected) - Number(b.autoRejected) || (b.fit ?? -1) - (a.fit ?? -1),
    );
  }

  const report = await latestReport();
  return {
    version: APP_VERSION,
    statusOrder: STATUS_ORDER,
    counts: Object.fromEntries(STATUS_ORDER.map((s) => [s, board[s].length])),
    board,
    scheduler: getSchedulerState(),
    report: report ? { date: report.date, markdown: report.markdown } : null,
    ollama: { up: await ollamaUpCached(), model: OLLAMA_MODEL },
  };
}

/**
 * Present the singleton search run as a Task so the Activity screen can render it in the same
 * table as tailoring. The two have genuinely different shapes — the run reports per-site counts
 * and a scored/toScore pair, a tailor task reports weighted steps — so rather than force one
 * model on both, this adapts the run at the edge.
 *
 * Phase weights are deliberately lopsided: scoring is one local model call per new job and can
 * run for hours, while the four board searches take a couple of minutes between them. A linear
 * phase bar would race to 80% and then appear stuck for the rest of the run.
 */
const SEARCH_PHASE_BANDS: Record<string, [number, number]> = {
  starting: [0, 0.02],
  searching: [0.02, 0.15],
  describing: [0.15, 0.25],
  filtering: [0.25, 0.3],
  scoring: [0.3, 0.95],
  finishing: [0.95, 1],
};

function searchAsTask(run: RunProgress): Task | null {
  if (run.phase === "idle" || !run.startedAt) return null;
  const [lo, hi] = SEARCH_PHASE_BANDS[run.phase] ?? [0, 1];
  // Inside the scoring band, use the real scored/toScore ratio — that is the only phase where
  // we know how much work is actually left.
  const within = run.phase === "scoring" && run.toScore > 0 ? run.scored / run.toScore : 0;
  const progress = run.running ? Math.min(1, lo + (hi - lo) * within) : 1;
  const elapsed = (Date.now() - Date.parse(run.startedAt)) / 1000;
  const eta =
    run.running && progress > 0.02 && progress < 1
      ? Math.max(0, Math.round(elapsed / progress - elapsed))
      : run.running
        ? null
        : 0;
  const sites = Object.entries(run.bySite)
    .map(([name, v]) => `${name} ${v.error ? "!" : v.count}`)
    .join(" · ");
  return {
    id: `search-${run.seq}`,
    // Sorted above any tailoring task: the run is the parent activity and belongs on top.
    seq: Number.MAX_SAFE_INTEGER,
    kind: "search",
    title: "Opportunity search",
    subtitle: sites || (run.found ? `${run.found} found` : "starting…"),
    state: run.running ? "running" : run.phase === "error" ? "error" : "done",
    stepIndex: 0,
    steps: [],
    progress,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    etaSeconds: eta,
    message: run.message,
    error: run.error,
    cancelRequested: false,
  };
}

/** Normalize a company name for cross-status matching (mirrors orchestrator's rule):
 *  lowercase, &→and, strip common suffixes (Ltd/Limited/…) and punctuation. */
function normCompany(c: string): string {
  return String(c || "")
    .toLowerCase()
    .replace(/&amp;/gi, "&")
    .replace(/&/g, "and")
    .replace(/\b(limited|ltd|inc|pty|nz|new zealand|group|holdings)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Qualitative ranking band. A bare 0-100 reads as false precision, so the board
 * shows a band; the number stays available in the drawer. Driven by skill
 * coverage (matched count) with the fit score as a tiebreaker.
 */
function rankBand(d: Record<string, any>): "strong" | "good" | "fair" | "weak" | "rejected" {
  if (d.autoRejected) return "rejected";
  const fit = typeof d.fit === "number" ? d.fit : 0;
  if (fit >= 75) return "strong";
  if (fit >= 55) return "good";
  if (fit >= 35) return "fair";
  return "weak";
}

/**
 * Translate a container-absolute application dir (under VAULT_PATH, e.g.
 * /vault/Career/Jobs/Applications/<slug>) into the path the user's machine sees,
 * given REVEAL_HOST_PATH (e.g. an SMB share such as \\nas\appdata\...\MyVault).
 * Picks the separator from the host base (UNC/Windows → "\", POSIX → "/").
 */
function toHostPath(containerDir: string): string {
  const base = config.revealHostPath.replace(/[/\\]+$/, "");
  const v = config.vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const c = containerDir.replace(/\\/g, "/");
  const rel = (c.toLowerCase().startsWith(v.toLowerCase()) ? c.slice(v.length) : c).replace(/^\/+/, "");
  const win = base.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(base) || base.includes("\\");
  const sep = win ? "\\" : "/";
  const parts = rel.split("/").filter(Boolean);
  return [base, ...parts].join(sep);
}

/**
 * Reveal the job's application folder so the user can attach the .docx files.
 * Two modes:
 *  - REVEAL_HOST_PATH set (container/remote): the server can't open the user's file
 *    manager, so return the translated host path for the browser to copy to clipboard.
 *  - otherwise (running locally): open the folder in the OS file manager directly.
 */
async function revealApplicationFolder(
  id: string,
): Promise<{ ok: boolean; message: string; folder?: string; copyPath?: boolean }> {
  const dir = await getApplicationDir(id);
  if (!dir) {
    log("warn", `Reveal requested but no application folder for job ${id}`);
    return { ok: false, message: "No application folder yet — mark the job Interested first." };
  }

  // Remote/container: hand the user-machine path back to the browser to copy.
  if (config.revealHostPath) {
    const hostPath = toHostPath(dir);
    log("info", `Reveal: ${dir} → host ${hostPath} (copied to clipboard)`);
    return {
      ok: true,
      copyPath: true,
      folder: hostPath,
      message: `Folder path copied — paste into Explorer:\n${hostPath}`,
    };
  }

  const platform = os.platform();
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "explorer.exe";
    args = [dir.replace(/\//g, "\\")];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [dir];
  } else {
    cmd = "xdg-open";
    args = [dir];
  }
  log("info", `Opening application folder in file manager: ${dir}`);
  // explorer.exe exits 1 even on success — fire-and-forget, don't surface its code. Only a
  // spawn failure (binary missing) is a real error worth logging; the exit code is ignored.
  execFile(cmd, args, (err) => {
    if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      log("warn", `Could not launch file manager (${cmd} not found): ${err.message}`);
    }
  });
  return { ok: true, message: "Opened the application folder — drag the .docx files onto your application.", folder: dir };
}

/**
 * First readable line of the description, for the card preview. Cuts the raw text to a
 * little over the output length BEFORE the markdown-stripping regexes run: this is called
 * once per note on every board build, and scrubbing whole multi-KB descriptions to keep
 * 220 characters was most of the cost.
 */
const SNIPPET_LEN = 220;
function snippet(body: string): string {
  const i = body.indexOf("## Description");
  const raw = i >= 0 ? body.slice(i + "## Description".length) : body;
  // 2x headroom so collapsing whitespace/markdown still leaves SNIPPET_LEN characters.
  const text = raw
    .slice(0, SNIPPET_LEN * 2)
    .replace(/[#>*_`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SNIPPET_LEN ? text.slice(0, SNIPPET_LEN) + "…" : text;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";

    // Static assets
    if (method === "GET" && (p === "/favicon.svg" || p === "/favicon.ico")) {
      return void (await serveStatic(res, "favicon.svg"));
    }
    // Full "Career OS" icon (with wordmark) as PNG — header logo, apple-touch, Unraid tile.
    // /icon.png kept as an alias so any existing Unraid config keeps resolving.
    if (method === "GET" && (p === "/logo.png" || p === "/icon.png" || p === "/apple-touch-icon.png")) {
      return void (await serveStatic(res, "logo.png"));
    }
    if (method === "GET" && p === "/") return void (await serveStatic(res, "index.html"));
    if (
      method === "GET" &&
      (p === "/opportunities" || p === "/application-ready" || p === "/applied" || p === "/unsuccessful" || p === "/dropped")
    ) {
      // All board screens share one HTML shell; the client (app.js VIEW map) picks
      // which status columns to render from the path.
      return void (await serveStatic(res, "opportunities.html"));
    }
    if (method === "GET" && p === "/activity") return void (await serveStatic(res, "activity.html"));
    if (method === "GET" && p === "/activity.js") return void (await serveStatic(res, "activity.js"));
    if (method === "GET" && p === "/admin") return void (await serveStatic(res, "admin.html"));
    if (method === "GET" && p === "/admin.js") return void (await serveStatic(res, "admin.js"));
    if (method === "GET" && p === "/dashboard.js") return void (await serveStatic(res, "dashboard.js"));
    if (method === "GET" && p === "/nav.js") return void (await serveStatic(res, "nav.js"));
    if (method === "GET" && p === "/notify.js") return void (await serveStatic(res, "notify.js"));
    if (method === "GET" && p === "/styles.css") return void (await serveStatic(res, "styles.css"));
    if (method === "GET" && p === "/app.js") return void (await serveStatic(res, "app.js"));

    // Read API. The payload-heavy reads pass `req` so json() can gzip the response.
    if (method === "GET" && p === "/api/state") return json(res, 200, await buildState(), req);
    if (method === "GET" && p === "/api/logs") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      return json(res, 200, { logs: getLogs(since) }, req);
    }
    if (method === "GET" && p === "/api/scheduler") return json(res, 200, getSchedulerState());
    // Live search progress. Small and polled often (alongside /api/logs), so the board can
    // show what a multi-minute run is doing — including one the scheduler started.
    if (method === "GET" && p === "/api/run-progress") return json(res, 200, getRunProgress());
    // Everything long-running in one list: the singleton search run (from runProgress) plus
    // every tailoring task. The Activity screen polls this.
    // Nav badge counts. Cheap by design — see buildCounts.
    if (method === "GET" && p === "/api/counts") return json(res, 200, await buildCounts());
    if (method === "GET" && p === "/api/activity") {
      const run = searchAsTask(getRunProgress());
      const tasks = listTasks();
      return json(res, 200, { tasks: run ? [run, ...tasks] : tasks });
    }
    if (method === "GET" && p === "/api/presets") return json(res, 200, { presets: await readPresets() });
    if (method === "GET" && p === "/api/job/docs") {
      const id = url.searchParams.get("id") ?? "";
      return json(res, 200, await getApplicationDocs(id), req);
    }
    // List the downloadable files in a job's application folder (name + size).
    if (method === "GET" && p === "/api/job/files") {
      const id = url.searchParams.get("id") ?? "";
      return json(res, 200, { ok: true, files: await listApplicationFiles(id) });
    }
    // Stream one application file as a download. OS-independent: the browser downloads it or
    // the user drags it out to their desktop — no file manager on the server host required.
    if (method === "GET" && p === "/api/job/file") {
      const id = url.searchParams.get("id") ?? "";
      const name = url.searchParams.get("name") ?? "";
      const full = await resolveApplicationFile(id, name);
      if (!full) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return void res.end("file not found");
      }
      const buf = await fs.readFile(full);
      const base = path.basename(full);
      res.writeHead(200, {
        "content-type": DOWNLOAD_MIME[path.extname(base).toLowerCase()] ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${base.replace(/["\r\n]/g, "")}"`,
        "content-length": buf.length,
      });
      return void res.end(buf);
    }
    if (method === "GET" && p === "/api/job") {
      const id = url.searchParams.get("id") ?? "";
      const note = id ? await getJobNoteById(id) : undefined;
      return note
        ? json(res, 200, {
            ...note.data,
            title: decodeEntities(String(note.data.title ?? "")),
            company: decodeEntities(String(note.data.company ?? "")),
            body: note.body,
            file: note.file,
          }, req)
        : json(res, 404, { error: "not found" });
    }

    // Action API
    if (method === "POST") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      switch (p) {
        case "/api/logs/clear":
          clearLogs();
          log("info", "Logs cleared from dashboard");
          return json(res, 200, { ok: true, message: "Logs cleared" });
        case "/api/presets": {
          const presets = body && typeof body.presets === "object" && body.presets && !Array.isArray(body.presets)
            ? body.presets
            : {};
          await writePresets(presets);
          return json(res, 200, { ok: true, message: "Presets saved to vault", presets });
        }
        case "/api/run":
          return json(res, 200, await runNow(parseOverrides(body)));
        case "/api/scheduler": {
          const next = await setSchedule({
            enabled: body.enabled,
            mode: body.mode,
            time: body.time,
            intervalMinutes: body.intervalMinutes,
          });
          log("info", `Scheduler updated: ${next.enabled ? (next.mode === "interval" ? `every ${next.intervalMinutes}m` : `daily ${next.time}`) : "off"}`);
          return json(res, 200, { ok: true, message: "Scheduler updated", scheduler: next });
        }
        case "/api/reenrich": {
          const files = await dedupeNoteFilesById();
          const dd = await dedupeLinkedInAgainstSeek();
          // Sweep Opportunities for roles already in Applied/Dropped, or listed twice
          // across sites, and drop them with dropReason "duplicate".
          const dupes = await dedupeOpportunities();
          const r = await reenrichDescriptions(["lead"]);
          // Re-check the roles you've already applied to and flag any listing that's now closed
          // (never drops them — they stay in Applied with an "expired" badge).
          const ax = await scanAppliedExpiry();
          return json(res, 200, {
            ok: true,
            message: `Refreshed ${r.enriched}/${r.scanned} descriptions · expired ${r.expired ?? 0} · applied expired ${ax.flagged + ax.confirmedGone}/${ax.scanned} · dropped ${dupes.dropped + dd.dropped} duplicate(s) · removed ${files.removed} duplicate note file(s)`,
            ...r,
            appliedExpiry: ax,
            duplicates: dupes,
            droppedDuplicates: dd.dropped + dupes.dropped,
            removedFiles: files.removed,
          }, req);
        }
        case "/api/activity/cancel":
          return json(res, 200, { ok: cancelTask(String(body.taskId ?? "")) });
        case "/api/activity/dismiss":
          return json(res, 200, { ok: dismissTask(String(body.taskId ?? "")) });
        case "/api/job/interested":
          return json(res, 200, await markInterested(id));
        case "/api/job/applied":
          return json(res, 200, await markApplied(id, body.date as string | undefined));
        case "/api/job/convert":
          try {
            const out = await convertApplicationDoc(id, body.doc as DocKind, body.format as DocFormat);
            return json(res, 200, { ok: true, message: `Saved ${path.basename(out.file)} to the application folder`, file: out.file });
          } catch (e) {
            return json(res, 200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        case "/api/job/drop":
          return json(res, 200, await dropJob(id));
        case "/api/job/status":
          return json(res, 200, await setStatus(id, body.status as JobStatus));
        case "/api/job/reveal":
          return json(res, 200, await revealApplicationFolder(id));
      }
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Verbose boot banner — prints the resolved config + health to stdout so container
 * logs (`make docker-logs` / Unraid) show exactly how the app is wired: where the
 * vault is mounted, whether Ollama is reachable, which scorer is active, etc.
 */
async function logBoot(): Promise<void> {
  console.log(`[boot] Career-OS v${APP_VERSION || "?"} — node ${process.version} ${process.platform}/${process.arch}`);

  let vaultInfo: string;
  try {
    const entries = await fs.readdir(config.vaultPath);
    const hasCareer = entries.includes("Career");
    vaultInfo = `mounted, ${entries.length} entries${hasCareer ? "" : " — WARNING: no Career/ folder (wrong mount?)"}`;
  } catch (e) {
    vaultInfo = `NOT READABLE — ${e instanceof Error ? e.message : String(e)} (is the vault bind-mount set?)`;
  }
  console.log(`[boot] VAULT_PATH=${config.vaultPath} (${vaultInfo})`);

  // The vault scan is latency-bound on a network share, so it lives or dies by how many
  // reads libuv will run at once. Node's default of 4 makes a full scan ~13x slower, and
  // nothing in-process can fix it after startup — so say so loudly rather than be slow
  // for no visible reason. Set by the npm scripts and the Dockerfile.
  const pool = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
  console.log(
    `[boot] UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? "(unset → 4)"}` +
      (pool >= 16 ? "" : " — WARNING: vault scans will be several times slower; launch via `npm run dashboard`"),
  );

  const up = await ollamaAvailable();
  console.log(
    `[boot] OLLAMA_URL=${OLLAMA_URL} model=${OLLAMA_MODEL} — ${up ? "reachable, model present" : "UNREACHABLE or model missing (LLM scoring/tailoring will degrade)"}`,
  );
  console.log(`[boot] scoring=${config.anthropicApiKey ? `Claude ${config.scoringModel}` : "Ollama (local)"}`);
  const scheduled = (process.env.SCHEDULE_ENABLED ?? "false") === "true";
  console.log(
    `[boot] ingest=${config.ingestSource}  TZ=${process.env.TZ ?? "(unset → UTC)"}  schedule=${scheduled ? `${process.env.SCHEDULE_TIME ?? "08:00"} daily` : "off"}`,
  );
}

/**
 * Persistent config dir (/app/config in the image). Bind-mounting it on Unraid mounts an
 * empty host folder over the image's baked copy, hiding the bundled logo. Seed it on boot
 * from the (never-mounted) web assets so the logo shows up in the mounted host folder.
 * Best-effort — a failure here must never stop the dashboard from starting. An existing
 * logo.png is left untouched so a user-supplied one is never overwritten.
 */
const CONFIG_DIR = process.env.CONFIG_DIR ?? path.resolve(WEB_DIR, "..", "..", "config");
async function seedConfigDir(): Promise<void> {
  const dest = path.join(CONFIG_DIR, "logo.png");
  try {
    await fs.access(dest);
    return; // already present — leave it (may be a user's custom logo)
  } catch {
    /* missing — seed below */
  }
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.copyFile(path.join(WEB_DIR, "logo.png"), dest);
    console.log(`[boot] seeded config logo → ${dest}`);
  } catch (e) {
    console.warn(`[boot] could not seed config logo: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Guard so the shutdown sequence (timer clear + server close) runs at most once. */
let shuttingDown = false;

/**
 * Graceful shutdown: stop the scheduler's timer and stop accepting connections, then
 * exit. Prevents a dangling setTimeout / open server socket from keeping the container
 * process alive on SIGTERM (docker stop) or SIGINT (Ctrl+C).
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — stopping scheduler and closing server…`);
  stopScheduler();
  // Force-exit if close() hangs on a slow in-flight request, so docker stop never
  // has to escalate to SIGKILL after its grace period.
  const force = setTimeout(() => {
    console.warn("[shutdown] close timed out — forcing exit");
    process.exit(0);
  }, 5000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    console.log("[shutdown] server closed — bye");
    process.exit(0);
  });
}

/** Register process-signal handlers once (idempotent across repeated startServer calls). */
function installShutdownHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
let signalsInstalled = false;

export async function startServer(): Promise<void> {
  await seedConfigDir();
  await logBoot();
  await startScheduler({
    enabled: (process.env.SCHEDULE_ENABLED ?? "false") === "true",
    time: process.env.SCHEDULE_TIME ?? "08:00",
  });
  installShutdownHandlers();
  // Warm the vault note cache in the background so the first board load doesn't pay for
  // the cold scan of the share. Best-effort — a failure here just means the first
  // /api/state does the scan itself.
  void listJobNotes()
    .then((n) => console.log(`[boot] vault note cache warm — ${n.length} job notes`))
    .catch((e) => console.warn(`[boot] vault warm-up failed: ${e instanceof Error ? e.message : String(e)}`));
  // Loopback-only by default — local tool, never exposed to the network.
  server.listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    console.log(`[boot] dashboard listening → http://${shown}:${PORT}  (bind ${HOST}:${PORT})`);
  });
}
