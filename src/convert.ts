import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
// `npm audit` reports 2 high-severity advisories against html-to-docx, via its declared
// dependency on image-size (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq). They are NOT actioned,
// deliberately, and the reasoning is recorded here so it is not re-litigated every audit:
//
//   - There is no fixed image-size. Both advisories cover <= 2.0.2 and 2.0.2 is the newest
//     published version, so no upgrade or `overrides` pin resolves them.
//   - The vulnerable code is never loaded. html-to-docx 1.8.0 declares image-size but its
//     shipped bundles (dist/*.js) contain no reference to it — verified by importing the
//     package and finding zero image-size modules in the require cache.
//   - Both advisories are denial of service via an infinite loop while parsing a malicious
//     ICNS/JXL/HEIF image. This module feeds html-to-docx the user's own resume HTML.
//   - The only remedy npm offers is downgrading to html-to-docx@1.1.2, ~40 releases back,
//     which BREAKS this file: 1.1.2 resolves to a Blob, and the `Buffer.from(buf)` below
//     throws ERR_INVALID_ARG_TYPE on one. Measured, not assumed.
//
// Revisit if image-size ships a patched release, or if this module ever renders images from
// a source the user did not write.
import HTMLtoDOCX from "html-to-docx";
import { getApplicationDir } from "./vault.js";
import { vault } from "./config.js";
import { resumeCvHtml, type CvExtras } from "./cvTemplate.js";
import { log, vlog } from "./logbus.js";

const execFileP = promisify(execFile);

export type DocKind = "resume" | "cover";
export type DocFormat = "docx" | "pdf";

const SRC_FILE: Record<DocKind, string> = {
  resume: "resume.md",
  cover: "cover-letter.md",
};
const OUT_NAME: Record<DocKind, string> = {
  resume: "resume",
  cover: "cover-letter",
};

/**
 * Convert a tailored document (resume/cover) to .docx or .pdf and save it next
 * to the markdown in the application folder. On Windows it drives Microsoft Word
 * via COM (best fidelity); elsewhere (e.g. the Linux container) it renders DOCX
 * in-process with html-to-docx. PDF is Windows/Word only.
 */
export async function convertApplicationDoc(
  id: string,
  doc: DocKind,
  format: DocFormat,
): Promise<{ file: string }> {
  const dir = await getApplicationDir(id);
  if (!dir) throw new Error("No application folder for this job — mark it Interested first.");

  const mdPath = path.join(dir, SRC_FILE[doc]);
  const md = await fs.readFile(mdPath, "utf8").catch(() => {
    throw new Error(`${SRC_FILE[doc]} not found in the application folder.`);
  });

  // Resumes render with the approved CV-2026 two-column template (banner + sidebar);
  // cover letters keep the plain single-column layout.
  const html =
    doc === "resume"
      ? resumeCvHtml(stripFrontmatter(md), await loadCvExtras(), OUT_NAME[doc])
      : mdToHtml(stripFrontmatter(md), OUT_NAME[doc]);
  const htmlPath = path.join(os.tmpdir(), `career-os-${doc}-${Date.now()}.html`);
  await fs.writeFile(htmlPath, html, "utf8");

  const outPath = path.join(dir, `${OUT_NAME[doc]}.${format}`);
  const engine = process.platform === "win32" ? "Word" : "html-to-docx";
  log("debug", `convert: ${SRC_FILE[doc]} → ${path.basename(outPath)} (${engine}, ${md.length} chars md)`);
  const t0 = Date.now();
  try {
    await renderDoc(htmlPath, html, outPath, format, doc);
  } finally {
    // Best-effort temp cleanup — a leftover temp HTML file is harmless, so a failed
    // unlink is logged at debug only and never masks the render result/error.
    await fs.rm(htmlPath, { force: true }).catch((e) =>
      log("debug", `convert: temp cleanup failed for ${path.basename(htmlPath)}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  log("debug", `convert: wrote ${path.basename(outPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { file: outPath };
}

export interface ConvertBothResult {
  files: string[]; // created document paths
  errors: string[]; // per-doc failures (e.g. Word not installed)
  wordUnavailable: boolean;
}

/**
 * Convert both tailored docs (resume + cover letter) for a job. Tolerant: if Word
 * is missing or one doc fails, it logs and keeps going — the markdown still exists.
 */
export async function convertBoth(id: string, format: DocFormat = "docx"): Promise<ConvertBothResult> {
  const files: string[] = [];
  const errors: string[] = [];
  let wordUnavailable = false;
  for (const doc of ["resume", "cover"] as DocKind[]) {
    try {
      log("info", `Generating ${OUT_NAME[doc]}.${format}…`);
      const { file } = await convertApplicationDoc(id, doc, format);
      files.push(file);
      log("info", `✓ Saved ${path.basename(file)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${doc}: ${msg}`);
      if (/Word isn't available|Word\.Application|class factory|80040154/i.test(msg)) wordUnavailable = true;
      log("warn", `Could not generate ${OUT_NAME[doc]}.${format}: ${msg}`);
    }
  }
  return { files, errors, wordUnavailable };
}

/**
 * Pick a converter by platform. Windows drives Word (COM) for the best fidelity.
 * Everywhere else (e.g. the Linux container, where Word and PowerShell don't exist)
 * we render DOCX in-process with html-to-docx. PDF needs Word, so it is Windows-only.
 */
async function renderDoc(
  htmlPath: string,
  html: string,
  outPath: string,
  format: DocFormat,
  doc: DocKind,
): Promise<void> {
  const engine = process.platform === "win32" ? "Word/COM" : "html-to-docx";
  vlog(`[convert] engine=${engine} format=${format} → ${path.basename(outPath)}`);
  if (process.platform === "win32") {
    await wordConvert(htmlPath, outPath, format);
    return;
  }
  if (format === "pdf") {
    throw new Error(
      "PDF export needs Microsoft Word (Windows only). Export DOCX here, or open the .md file directly.",
    );
  }
  await docxFromHtml(html, outPath, doc);
}

/** Render HTML to a .docx buffer in-process (no native deps) and write it out. */
async function docxFromHtml(html: string, outPath: string, doc: DocKind): Promise<void> {
  const t0 = Date.now();
  // fontSize is in half-points: 21 = 10.5pt, matching the body style in wrap().
  // The resume mirrors the CV-2026 page geometry (A4, 1cm top / 1.2cm sides+bottom,
  // in twips) — html-to-docx ignores the @page CSS the Word engine uses for this.
  const resumeMargins = { top: 567, right: 680, bottom: 680, left: 680, header: 720, footer: 720, gutter: 0 };
  const buf = await HTMLtoDOCX(html, null, {
    font: "Calibri",
    fontSize: 21,
    ...(doc === "resume" ? { margins: resumeMargins } : {}),
  });
  const out = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  await fs.writeFile(outPath, out);
  vlog(`[convert] html ${html.length} ch → ${path.basename(outPath)} ${out.length} b in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** Drive Microsoft Word (COM) to open the HTML and save it as docx/pdf. */
async function wordConvert(htmlPath: string, outPath: string, format: DocFormat): Promise<void> {
  const esc = (p: string) => p.replace(/'/g, "''");
  const save =
    format === "pdf"
      ? `$doc.ExportAsFixedFormat('${esc(outPath)}', 17)` // 17 = wdExportFormatPDF
      : `$doc.SaveAs([ref]'${esc(outPath)}', [ref]16)`; // 16 = wdFormatDocumentDefault (.docx)

  const script = [
    `$ErrorActionPreference='Stop'`,
    `$word = New-Object -ComObject Word.Application`,
    `$word.Visible = $false`,
    `$word.DisplayAlerts = 0`,
    `try {`,
    `  $doc = $word.Documents.Open('${esc(htmlPath)}', $false, $true)`,
    `  ${save}`,
    `  $doc.Close($false)`,
    `} finally { try { $word.Quit() | Out-Null } catch {} }`,
  ].join("\n");

  const scriptPath = path.join(os.tmpdir(), `career-os-word-${Date.now()}.ps1`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    await execFileP("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      timeout: 120_000,
      windowsHide: true,
    });
  } catch (e: any) {
    const detail = String(e?.stderr || e?.message || e);
    // COM class factory failure = Word not installed/registered on this machine.
    if (/80040154|class factory|Word\.Application|Cannot find an object/i.test(detail)) {
      throw new Error(
        "Microsoft Word isn't available to convert this document. Use Copy to paste the markdown, or open the .md file directly.",
        { cause: e },
      );
    }
    throw new Error(`Word conversion failed: ${detail}`, { cause: e });
  } finally {
    // Best-effort temp cleanup — a leftover .ps1 is harmless; log at debug, never mask.
    await fs.rm(scriptPath, { force: true }).catch((e) =>
      log("debug", `convert: temp cleanup failed for ${path.basename(scriptPath)}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
}

/**
 * Sidebar extras for the CV template, read from the resume-master frontmatter
 * (`sidebar_skills`, `work_rights`). Missing file/keys degrade to empty lists —
 * the template then derives sidebar skills from the resume's own categories.
 */
async function loadCvExtras(): Promise<CvExtras> {
  try {
    const fm = matter(await fs.readFile(vault.resumeMaster, "utf8")).data as Record<string, unknown>;
    const list = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.map((s) => String(s).trim()).filter(Boolean)
        : typeof v === "string" && v.trim()
          ? v.split("|").map((s) => s.trim()).filter(Boolean)
          : [];
    return { sidebarSkills: list(fm.sidebar_skills), workRights: list(fm.work_rights) };
  } catch {
    return { sidebarSkills: [], workRights: [] };
  }
}

// --- minimal, correct Markdown → HTML ---------------------------------------

/** Convert the simple markdown our docs use into clean HTML Word imports well. */
export function mdToHtml(md: string, title: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      // Preserve intentional line breaks (resume contact header, cover-letter address
      // block) by joining lines with <br/> instead of collapsing them with a space.
      out.push(`<p>${para.map((l) => inline(l.trim())).join("<br/>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!.trim())}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara();
      flushList();
      out.push("<hr/>");
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      const item = (ul ? ul[1] : ol![1])!.trim();
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();

  return wrap(out.join("\n"), title);
}

/** Inline markdown: escape, then links, bold, italic, code. Order matters. */
export function inline(s: string): string {
  let t = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);
  // Inline font-weight (not <strong>/<b>) so Word imports DIRECT bold formatting
  // (<w:b/>) instead of mapping to the "Strong" character style, which the user's
  // Normal template could have overridden.
  t = t.replace(/\*\*([^*]+?)\*\*/g, '<span style="font-weight:bold">$1</span>');
  t = t.replace(/__([^_]+?)__/g, '<span style="font-weight:bold">$1</span>');
  t = t.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<span style="font-style:italic">$2</span>');
  // Single-underscore italic, but only when the underscores are word-boundaries so
  // snake_case identifiers are never italicised.
  t = t.replace(
    /(^|[^A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/g,
    '$1<span style="font-style:italic">$2</span>',
  );
  t = t.replace(/`([^`]+?)`/g, "<code>$1</code>");
  return t;
}

function wrap(bodyHtml: string, title: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${title}</title>
<style>
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 10.5pt; color: #222222; line-height: 1.3; }
  h1 { font-size: 22pt; font-weight: bold; margin: 0 0 2pt; color: #1a1a1a; }
  h2 { font-size: 12pt; font-weight: bold; margin: 14pt 0 5pt; padding-bottom: 2pt; border-bottom: 1px solid #999999; color: #1a1a1a; }
  h3 { font-size: 11pt; font-weight: bold; margin: 9pt 0 2pt; color: #1a1a1a; }
  p { margin: 3pt 0; }
  ul, ol { margin: 3pt 0 6pt; padding-left: 18pt; }
  li { margin: 1.5pt 0; }
  strong { font-weight: bold; }
  a { color: #0563c1; text-decoration: none; }
  code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; }
  hr { border: none; border-top: 1px solid #cccccc; margin: 8pt 0; }
</style></head>
<body>
${bodyHtml}
</body></html>`;
}
