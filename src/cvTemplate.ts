import { inline } from "./convert.js";

/**
 * CV-2026 resume renderer. Turns a tailored resume.md into the exact look of the
 * approved master CV document (the `source_docx` named in resume-master.md's frontmatter):
 * a full-width taupe name banner, a cream left sidebar (CONTACT / EDUCATION /
 * TRAINING / SKILLS) and a main column (PROFESSIONAL SUMMARY / WORK EXPERIENCE /
 * TECHNICAL SKILLS). All colours, fonts, and sizes were measured from that file.
 */

// Palette + typography measured from the approved master CV.
const C = {
  ink: "#2B2824", // body text
  muted: "#5C564E", // dates, training entries
  accent: "#6E6052", // company names, links, right-to-work note
  banner: "#8A7968", // name banner fill
  sidebar: "#F6F2EA", // sidebar fill
};
const SEGOE = "'Segoe UI', Arial, sans-serif";

export interface CvExtras {
  /** Short skill lines for the sidebar SKILLS list (from resume-master frontmatter). */
  sidebarSkills: string[];
  /** Right-to-work / availability lines for the sidebar CONTACT block. */
  workRights: string[];
}

interface Contact {
  location?: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  github?: string;
}

interface ExperienceEntry {
  title: string;
  company?: string;
  dates?: string;
  /** Non-bullet lines between the heading and the bullets (e.g. a dual-role line). */
  paras: string[];
  bullets: string[];
  /** Non-bullet lines after the bullets (e.g. the "Earlier roles:" paragraph). */
  tail: string[];
}

interface SkillCategory {
  label: string;
  text: string;
}

interface GenericSection {
  title: string;
  /** Lines kept in order; bullets keep their "- " marker so the renderer can group them. */
  lines: string[];
}

interface ResumeModel {
  name: string;
  role: string;
  contact: Contact;
  workRights: string[];
  summary: string[];
  skills: SkillCategory[];
  experience: ExperienceEntry[];
  education: string[]; // markdown items with bold → sidebar EDUCATION
  training: string[]; // plain items → sidebar TRAINING
  /** Sections other than the known ones (old-format resumes) — rendered in the main column. */
  extra: GenericSection[];
  /** Trailing standalone paragraphs (e.g. "Referees available on request."). */
  footer: string[];
}

// --- parsing -----------------------------------------------------------------

/** Parse the resume markdown (frontmatter already stripped) into a layout model. */
export function parseResume(md: string): ResumeModel {
  const model: ResumeModel = {
    name: "",
    role: "",
    contact: {},
    workRights: [],
    summary: [],
    skills: [],
    experience: [],
    education: [],
    training: [],
    extra: [],
    footer: [],
  };

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const firstSection = lines.findIndex((l) => /^##\s+/.test(l));
  const head = lines.slice(0, firstSection < 0 ? lines.length : firstSection);
  parseHeader(head, model);

  let i = firstSection;
  while (i >= 0 && i < lines.length) {
    const m = lines[i]!.match(/^##\s+(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const title = m[1]!.trim();
    let end = i + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end]!)) end++;
    const body = lines.slice(i + 1, end);
    routeSection(title, body, model);
    i = end;
  }
  return model;
}

function parseHeader(head: string[], model: ResumeModel): void {
  for (const raw of head) {
    const line = raw.trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      model.name = h1[1]!.trim();
      continue;
    }
    const bold = line.match(/^\*\*(.+)\*\*$/);
    if (bold) {
      const text = bold[1]!.trim();
      // First bold line is the role headline; later ones (right to work / open to
      // remote) belong in the sidebar CONTACT block.
      if (!model.role && !/right to work|open to/i.test(text)) model.role = text;
      else model.workRights.push(...text.split("|").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (/^\*[^*].*\*$/.test(line)) continue; // tagline — the approved CV design omits it
    // Contact rows: "Label: value | Label: value" or bare "linkedin.com/…" pieces.
    for (const piece of line.split("|").map((s) => s.trim()).filter(Boolean)) {
      const labelled = piece.match(/^([A-Za-z]+):\s*(.+)$/);
      const [label, value] = labelled
        ? [labelled[1]!.toLowerCase(), labelled[2]!.trim()]
        : [guessContactLabel(piece), piece];
      if (label && value && label in model.contact === false) {
        (model.contact as Record<string, string>)[label] ??= value;
      }
    }
  }
}

function guessContactLabel(piece: string): string {
  if (piece.includes("@")) return "email";
  if (/linkedin\.com/i.test(piece)) return "linkedin";
  if (/github\.com/i.test(piece)) return "github";
  if (/^[\d\s()+-]{7,}$/.test(piece)) return "phone";
  if (/new zealand|,/i.test(piece)) return "location";
  return "";
}

function routeSection(title: string, body: string[], model: ResumeModel): void {
  const t = title.toLowerCase();
  if (t.startsWith("professional summary")) {
    model.summary = paragraphs(body);
  } else if (t.startsWith("technical skills")) {
    model.skills = parseSkillCategories(body);
  } else if (t.startsWith("work experience")) {
    parseExperience(body, model);
  } else if (t.startsWith("education")) {
    for (const line of body) {
      const item = line.match(/^\s*[-*+]\s+(.*)$/);
      if (item) {
        // Bold-marked entries are formal education/certifications; plain ones are
        // short courses → the sidebar TRAINING list (mirrors the approved CV split).
        (item[1]!.includes("**") ? model.education : model.training).push(item[1]!.trim());
      } else if (line.trim()) {
        // Sub-bullets ("  - Award: …") fold into the previous education item;
        // standalone prose (e.g. "Referees available on request.") is page footer.
        if (/^\s{2,}/.test(line) && model.education.length) {
          model.education[model.education.length - 1] += ` - ${line.trim().replace(/^[-*+]\s+/, "")}`;
        } else {
          model.footer.push(line.trim());
        }
      }
    }
  } else {
    model.extra.push({ title, lines: body.map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => l || a[i - 1]) });
  }
}

function paragraphs(body: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of body) {
    if (!line.trim()) {
      if (cur.length) out.push(cur.join(" "));
      cur = [];
    } else cur.push(line.trim());
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/** "- **Label:** text" bullets or "**Label:** text" paragraphs → labelled categories. */
function parseSkillCategories(body: string[]): SkillCategory[] {
  const cats: SkillCategory[] = [];
  for (const line of body) {
    const m = line.match(/^\s*(?:[-*+]\s+)?\*\*(.+?):\*\*\s*(.*)$/);
    if (m) cats.push({ label: m[1]!.trim(), text: m[2]!.trim() });
    else if (line.trim() && cats.length) cats[cats.length - 1]!.text += ` ${line.trim()}`;
  }
  return cats;
}

function parseExperience(body: string[], model: ResumeModel): void {
  let cur: ExperienceEntry | null = null;
  for (const line of body) {
    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      if (cur) model.experience.push(cur);
      cur = { ...splitRoleHeading(h[1]!.trim()), paras: [], bullets: [], tail: [] };
      continue;
    }
    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b && cur) {
      cur.bullets.push(b[1]!.trim());
      continue;
    }
    if (line.trim()) {
      if (cur) (cur.bullets.length ? cur.tail : cur.paras).push(line.trim());
      else model.footer.push(line.trim());
    }
  }
  if (cur) model.experience.push(cur);
}

/**
 * "Title - Company | dates" / "Title | dates" → parts. The company separator is
 * " - " (spaced) so hyphenated titles ("Senior Platform Reliability Specialist -
 * Example Corp (UK)") split correctly and "self-directed" never does.
 */
function splitRoleHeading(heading: string): { title: string; company?: string; dates?: string } {
  const pipe = heading.lastIndexOf("|");
  let left = heading;
  let dates: string | undefined;
  if (pipe >= 0) {
    const right = heading.slice(pipe + 1).trim();
    if (/\d{4}|present|current/i.test(right)) {
      dates = right;
      left = heading.slice(0, pipe).trim();
    }
  }
  const dash = left.indexOf(" - ");
  if (dash >= 0) {
    return { title: left.slice(0, dash).trim(), company: left.slice(dash + 3).trim(), dates };
  }
  return { title: left, dates };
}

// --- rendering ---------------------------------------------------------------

const strip = (s: string) => s.replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\*([^*]+?)\*/g, "$1");

const sideHead = (text: string, first = false) =>
  `<p style="font-family:${SEGOE};font-size:11.5pt;font-weight:bold;color:${C.ink};letter-spacing:1.5pt;margin:${first ? 4 : 14}pt 0 4pt">${text.toUpperCase()}</p>`;

const mainHead = (text: string, first = false) =>
  `<p style="font-family:${SEGOE};font-size:13pt;font-weight:bold;color:${C.ink};letter-spacing:1pt;margin:${first ? 2 : 12}pt 0 4pt">${text.toUpperCase()}</p>`;

const p = (html: string, size: number, opts: { color?: string; bold?: boolean; margin?: string } = {}) =>
  `<p style="font-size:${size}pt;color:${opts.color ?? C.ink};${opts.bold ? "font-weight:bold;" : ""}margin:${opts.margin ?? "1pt 0"}">${html}</p>`;

const bulletList = (items: string[], size = 10) =>
  items.length
    ? `<ul style="margin:2pt 0 6pt;padding-left:12pt">${items
        .map((b) => `<li style="font-size:${size}pt;color:${C.ink};margin:1.5pt 0">${inline(b)}</li>`)
        .join("")}</ul>`
    : "";

function renderSidebar(model: ResumeModel, extras: CvExtras): string {
  const out: string[] = [];
  const link = (url: string, label: string) =>
    `<a href="https://${url.replace(/^https?:\/\//, "")}" style="color:${C.accent};text-decoration:none">${label}</a>`;

  out.push(sideHead("Contact", true));
  const c = model.contact;
  for (const v of [c.email, c.phone, c.location]) {
    if (v) out.push(p(inline(v), 9.5, { bold: true, margin: "2pt 0" }));
  }
  if (c.linkedin) out.push(p(link(c.linkedin, "LinkedIn"), 9.5, { margin: "2pt 0" }));
  if (c.github) out.push(p(link(c.github, "GitHub"), 9.5, { margin: "2pt 0" }));
  const rights = model.workRights.length ? model.workRights : extras.workRights;
  rights.forEach((r, i) =>
    out.push(p(strip(r), 8.5, { bold: true, color: C.accent, margin: i === 0 ? "6pt 0 1pt" : "1pt 0" })),
  );

  if (model.education.length) {
    out.push(sideHead("Education"));
    for (const item of model.education) {
      // "**Qualification** - Detail" → bold line + detail line, as in the approved CV.
      for (const part of strip(item).split(/\s+-\s+/)) {
        out.push(p(part, 9, { bold: true, margin: "1pt 0" }));
      }
      out.push(`<p style="font-size:4pt;margin:0">&nbsp;</p>`);
    }
  }

  if (model.training.length) {
    out.push(sideHead("Training"));
    for (const item of model.training) out.push(p(strip(item), 8.5, { bold: true, color: C.muted, margin: "2pt 0" }));
  }

  const skills = extras.sidebarSkills.length ? extras.sidebarSkills : deriveSidebarSkills(model.skills);
  if (skills.length) {
    out.push(sideHead("Skills"));
    for (const s of skills) out.push(p(strip(s), 9.5, { bold: true, margin: "2pt 0" }));
  }
  return out.join("\n");
}

/** No curated list available — fall back to the first entry of each skill category. */
function deriveSidebarSkills(cats: SkillCategory[]): string[] {
  return cats
    .map((c) => strip(c.text).split(",")[0]!.trim())
    .filter((s) => s && s.length <= 34)
    .slice(0, 16);
}

function renderExperience(e: ExperienceEntry): string {
  const out: string[] = [];
  out.push(p(strip(e.title), 12.5, { bold: true, margin: "9pt 0 0" }));
  if (e.company) out.push(p(strip(e.company), 11, { color: C.accent, margin: "1pt 0 0" }));
  if (e.dates) out.push(p(e.dates, 9.5, { color: C.muted, margin: "1pt 0 3pt" }));
  for (const para of e.paras) out.push(p(inline(para), 10, { margin: "2pt 0" }));
  out.push(bulletList(e.bullets));
  for (const para of e.tail) out.push(p(inline(para), 10, { margin: "2pt 0" }));
  return out.join("\n");
}

function renderGenericSection(s: GenericSection): string {
  const out: string[] = [mainHead(s.title)];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) out.push(bulletList(bullets));
    bullets = [];
  };
  for (const line of s.lines) {
    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b) bullets.push(b[1]!.trim());
    else if (line.trim()) {
      flush();
      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) out.push(p(strip(h3[1]!), 12.5, { bold: true, margin: "9pt 0 2pt" }));
      else out.push(p(inline(line.trim()), 10, { margin: "2pt 0" }));
    }
  }
  flush();
  return out.join("\n");
}

function renderMain(model: ResumeModel): string {
  const out: string[] = [];
  if (model.summary.length) {
    out.push(mainHead("Professional Summary", true));
    for (const para of model.summary) out.push(p(inline(para), 10, { margin: "2pt 0 4pt" }));
  }
  if (model.experience.length) {
    out.push(mainHead("Work Experience"));
    for (const e of model.experience) out.push(renderExperience(e));
  }
  for (const s of model.extra) out.push(renderGenericSection(s));
  if (model.skills.length) {
    out.push(mainHead("Technical Skills"));
    for (const c of model.skills) {
      out.push(p(`<span style="font-weight:bold">${strip(c.label)}:</span> ${inline(c.text)}`, 10, { margin: "2pt 0 4pt" }));
    }
  }
  for (const f of model.footer) out.push(p(inline(f), 9, { color: C.muted, margin: "8pt 0 0" }));
  return out.join("\n");
}

/** Render the resume markdown to the CV-2026 two-column HTML that Word converts to docx/pdf. */
export function resumeCvHtml(md: string, extras: CvExtras, title: string): string {
  const model = parseResume(md);
  const banner = [
    `<p style="font-family:${SEGOE};font-size:26pt;color:#FFFFFF;letter-spacing:4pt;margin:0">${strip(model.name).toUpperCase()}</p>`,
    `<p style="font-family:${SEGOE};font-size:12pt;font-weight:bold;color:#FFFFFF;letter-spacing:2pt;margin:2pt 0 0">${strip(model.role).toUpperCase()}</p>`,
  ].join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${title}</title>
<style>
  @page WordSection1 { size:595.35pt 841.95pt; margin:28.35pt 34pt 34pt 34pt; }
  div.WordSection1 { page:WordSection1; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; color:${C.ink}; line-height:1.25; }
  p { margin:0; }
  a { color:${C.accent}; text-decoration:none; }
</style></head>
<body><div class="WordSection1">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:527pt"><tr>
<td bgcolor="${C.banner}" style="background-color:${C.banner};width:527pt;padding:10pt 12pt 11pt 12pt">
${banner}
</td></tr></table>
<p style="font-size:6pt;margin:0">&nbsp;</p>
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:527pt"><tr>
<td valign="top" bgcolor="${C.sidebar}" style="background-color:${C.sidebar};width:158pt;padding:6pt 11pt 10pt 11pt">
${renderSidebar(model, extras)}
</td>
<td valign="top" style="width:369pt;padding:4pt 0 4pt 14pt">
${renderMain(model)}
</td></tr></table>
</div></body></html>`;
}
