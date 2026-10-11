// Career OS dashboard — vanilla ESM, no build step.
const $ = (sel, root = document) => root.querySelector(sel);

const STATUS_LABEL = {
  lead: "Opportunities",
  interested: "Interested",
  tailoring: "Application Ready",
  applied: "Applied",
  unsuccessful: "Unsuccessful Applications",
  dropped: "Dropped",
};

// Each board screen renders a subset of status columns; siblings live on other
// screens (see the nav.js menu). Path → columns to show + the ribbon title.
const VIEWS = {
  "/opportunities": { statuses: ["lead", "interested"], title: "Opportunities" },
  "/application-ready": { statuses: ["tailoring"], title: "Application Ready" },
  "/applied": { statuses: ["applied"], title: "Applied" },
  "/unsuccessful": { statuses: ["unsuccessful"], title: "Unsuccessful" },
  "/dropped": { statuses: ["dropped"], title: "Dropped" },
};
const VIEW = VIEWS[location.pathname.replace(/\/+$/, "")] ||
  { statuses: ["lead", "interested", "tailoring", "applied", "unsuccessful", "dropped"], title: "Board" };

const BAND = {
  strong: { label: "Strong", rank: 4 },
  good: { label: "Good", rank: 3 },
  fair: { label: "Fair", rank: 2 },
  weak: { label: "Weak", rank: 1 },
  rejected: { label: "Filtered", rank: 0 },
};

const TYPE_LABEL = {
  "full-time": "Full-time",
  "part-time": "Part-time",
  contract: "Contract / temp",
  casual: "Casual",
};
const ARRANGEMENT_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

// Primary one-click action per column.
const PRIMARY = {
  lead: { label: "Interested", icon: "⭐", kind: "primary", run: (id) => interested(id) },
  interested: { label: "Re-tailor", icon: "✎", run: (id) => interested(id) },
  tailoring: { label: "View", icon: "▸", kind: "primary", run: (id) => openDrawer(id) },
  applied: { label: "View", icon: "▸", kind: "primary", run: (id) => openDrawer(id) },
  unsuccessful: { label: "View", icon: "▸", kind: "primary", run: (id) => openDrawer(id) },
};

let lastState = null;
const filters = { search: "", source: "", type: "", engagement: "", remote: "", region: "", district: "", band: "", sort: "match" };
const FILTER_DEFAULTS = { search: "", source: "", type: "", engagement: "", remote: "", region: "", district: "", band: "", sort: "match" };

const ENGAGEMENT_LABEL = { permanent: "Permanent", contract: "Contract / temp" };

// NZ regions → main districts / territorial authorities. Used by the Location filter
// to match a job's free-text location: a region matches when the location names the
// region OR any of its districts. Matching is diacritic-insensitive (see norm()).
const NZ_REGIONS = {
  "Northland": ["Far North", "Whangārei", "Kaipara"],
  "Auckland": ["Auckland", "Rodney", "North Shore", "Waitākere", "Manukau", "Papakura", "Franklin"],
  "Waikato": ["Hamilton", "Waikato", "Hauraki", "Thames-Coromandel", "Matamata-Piako", "Waipā", "Ōtorohanga", "South Waikato", "Waitomo", "Taupō"],
  "Bay of Plenty": ["Tauranga", "Rotorua", "Western Bay of Plenty", "Whakatāne", "Kawerau", "Ōpōtiki"],
  "Gisborne": ["Gisborne"],
  "Hawke's Bay": ["Napier", "Hastings", "Wairoa", "Central Hawke's Bay"],
  "Taranaki": ["New Plymouth", "Stratford", "South Taranaki"],
  "Manawatū-Whanganui": ["Palmerston North", "Whanganui", "Manawatū", "Rangitīkei", "Ruapehu", "Tararua", "Horowhenua"],
  "Wellington": ["Wellington", "Lower Hutt", "Upper Hutt", "Porirua", "Kāpiti Coast", "Masterton", "Carterton", "South Wairarapa"],
  "Tasman": ["Richmond", "Motueka", "Tasman"],
  "Nelson": ["Nelson"],
  "Marlborough": ["Blenheim", "Marlborough"],
  "West Coast": ["Buller", "Westport", "Grey", "Greymouth", "Westland", "Hokitika"],
  "Canterbury": ["Christchurch", "Selwyn", "Waimakariri", "Ashburton", "Timaru", "Mackenzie", "Waimate", "Hurunui", "Kaikōura"],
  "Otago": ["Dunedin", "Queenstown-Lakes", "Queenstown", "Wānaka", "Central Otago", "Clutha", "Waitaki", "Oamaru"],
  "Southland": ["Invercargill", "Gore", "Southland"],
};
// Lowercase + strip diacritics so "Whangārei" matches "Whangarei", etc.
function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, ""); }

// ---- networking -------------------------------------------------------------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (url === "/api/run") {
    // The progress banner narrates a successful run (including its found count), so only
    // a failure needs a toast — two success messages for one run is just noise.
    if (!r.ok || data.error) toast("Search failed: " + (data.error || r.statusText), false);
  } else if ("ok" in data) {
    toast(data.message, data.ok);
  }
  await refresh();
  // Every POST here changes a job's status or starts work, so the nav badges are now stale.
  // Waiting for their 15s poll makes them look broken right after you click something.
  window.dispatchEvent(new CustomEvent("careeros:counts-stale"));
  return data;
}

async function interested(id) {
  // Tailoring now runs in the background and can take many minutes on a 32B local model, so
  // the old "~45-90s, watch the LOGS panel" toast was both wrong and the only feedback there
  // was. Point at the Activity screen, which shows the step and a progress bar.
  toast("Tailoring started — follow progress on the Activity screen.", true, 8000);
  await post("/api/job/interested", { id });
}

// Re-fetch full descriptions for every job in Opportunities and update the fuller
// ones. Lives in the Opportunities column header; pass the button to show progress.
async function reenrichDetails(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  toast("Re-fetching full descriptions for Opportunities… watch the LOGS panel", true, 60000);
  try {
    await post("/api/reenrich", {});
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh details"; }
  }
}

// Mark a job Applied. Prompts for the date (defaults to today), then records it
// onto the Obsidian note and moves the card to the Applied column.
async function applyJob(id, presetDate) {
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  const date = presetDate !== undefined ? presetDate : prompt("Date you applied (YYYY-MM-DD):", today);
  if (date === null) return; // cancelled
  await post("/api/job/applied", { id, date: date.trim() || today });
}

// Open the job's application folder (resume.docx + cover-letter.docx) in Explorer,
// so the files are right there to attach to the online application.
function revealBtn(id) {
  return el(
    "button",
    {
      class: "btn btn-sm",
      title: "Jump to the file list — download or drag the resume/cover-letter files",
      onclick: (e) => { e.stopPropagation(); revealFiles(id); },
    },
    "📂 Show files",
  );
}

// Copy text to the clipboard, with a fallback for plain-HTTP origins (LAN) where the
// async Clipboard API is unavailable (it needs a secure context).
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// "Show files": scroll to the in-drawer Files list (download / drag-and-drop). This is
// OS-independent — it never asks the server to open a file manager (which fails in a
// container: "xdg-open not found"). The list is rendered by appendFilesList().
function revealFiles(id) {
  const sec = document.querySelector(".files-section");
  if (sec) {
    sec.scrollIntoView({ behavior: "smooth", block: "center" });
    sec.classList.add("flash");
    setTimeout(() => sec.classList.remove("flash"), 1200);
  } else {
    toast("No files yet — mark the job Interested to generate them.", true);
  }
}

/** Human size label, e.g. "12.4 KB". */
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Content type by extension, for the drag-out DownloadURL. */
function mimeOf(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    md: "text/markdown", txt: "text/plain", pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    png: "image/png", json: "application/json",
  }[ext] || "application/octet-stream";
}

// Render the downloadable, drag-and-droppable file list for a job's application folder.
// Each row is a real download link AND draggable: dragging it to the desktop (Chrome/Edge)
// drops the actual file via the DownloadURL flavour; download works in every browser/OS.
async function appendFilesList(container, id) {
  let data;
  try {
    data = await getJSON("/api/job/files?id=" + encodeURIComponent(id));
  } catch {
    return;
  }
  const files = (data && data.files) || [];
  if (!files.length) return;

  const list = el("div", { class: "files" });
  for (const f of files) {
    const url = "/api/job/file?id=" + encodeURIComponent(id) + "&name=" + encodeURIComponent(f.name);
    const abs = location.origin + url;
    const row = el("div", { class: "file-row", draggable: "true", title: "Download, or drag me to your desktop" },
      el("a", { class: "file-link", href: url, download: f.name }, "⬇ " + f.name),
      el("span", { class: "file-size" }, fmtSize(f.size)),
    );
    row.addEventListener("dragstart", (e) => {
      // DownloadURL = drag a real file out to the OS desktop (Chromium). The uri-list/plain
      // flavours let it drop onto web upload widgets and text fields too.
      try { e.dataTransfer.setData("DownloadURL", mimeOf(f.name) + ":" + f.name + ":" + abs); } catch { /* not supported */ }
      e.dataTransfer.setData("text/uri-list", abs);
      e.dataTransfer.setData("text/plain", abs);
      e.dataTransfer.effectAllowed = "copy";
    });
    list.append(row);
  }
  container.append(
    el("div", { class: "docs files-section" },
      el("h3", {}, "Files"),
      el("div", { class: "panel-note" }, "Click to download, or drag a file straight onto your desktop or the job site's upload box."),
      list,
    ),
  );
}

// ---- helpers ----------------------------------------------------------------
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}
// Closing date with urgency: "Closes in 5d", "Closes today", "Closed".
function closesLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const days = Math.ceil((d - Date.now()) / 86400000);
  if (days < 0) return { text: "Closed", urgent: true };
  if (days === 0) return { text: "Closes today", urgent: true };
  if (days <= 3) return { text: `Closes in ${days}d`, urgent: true };
  return { text: `Closes ${fmtDay(iso)}`, urgent: false };
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

// Minimal, safe Markdown → HTML for the tailored-doc viewer (matches the docx
// export). Escapes first, so document text can never inject markup.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdInline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>");
}
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null; // { type, items }
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(" ").trim())}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join("")}</${list.type}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${mdInline(h[2].trim())}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); flushList(); out.push("<hr/>"); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((ul ? ul[1] : ol[1]).trim());
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join("\n");
}

// ---- filtering --------------------------------------------------------------
function matchesFilters(job) {
  if (filters.source && job.source !== filters.source) return false;
  if (filters.type && job.employmentType !== filters.type) return false;
  if (filters.engagement && job.engagement !== filters.engagement) return false;
  if (filters.remote && job.workArrangement !== filters.remote) return false;
  if (filters.region) {
    const hay = norm(job.location);
    const ds = NZ_REGIONS[filters.region] || [];
    // Region matches when the location names the region itself or any of its districts.
    if (!hay.includes(norm(filters.region)) && !ds.some((d) => hay.includes(norm(d)))) return false;
  }
  if (filters.district && !norm(job.location).includes(norm(filters.district))) return false;
  if (filters.band) {
    const need = BAND[filters.band].rank;
    if ((BAND[job.band]?.rank ?? 0) < need) return false;
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    if (!`${job.title} ${job.company}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
// Active table sort — key + direction. Driven by clicking a column header or the
// Sort dropdown. Default: best match (band/fit) descending.
let sort = { key: "fit", dir: "desc" };
const SORT_NUM = new Set(["fit"]);
const SORT_DATE = new Set(["posted", "closes", "ingested", "scored", "applied"]);

function sortVal(job, key) {
  if (key === "band") return BAND[job.band]?.rank ?? 0;
  if (SORT_NUM.has(key)) return Number(job[key] ?? -1);
  if (SORT_DATE.has(key)) return Date.parse(job[key] || "") || -Infinity;
  return String(job[key] ?? "").toLowerCase();
}

function sortJobs(jobs) {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const va = sortVal(a, sort.key);
    const vb = sortVal(b, sort.key);
    const c = (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    // Stable tiebreak so equal keys keep a sensible order.
    return (
      c ||
      Number(a.autoRejected) - Number(b.autoRejected) ||
      (BAND[b.band]?.rank ?? 0) - (BAND[a.band]?.rank ?? 0) ||
      (b.fit ?? -1) - (a.fit ?? -1)
    );
  });
}

// Columns shown in every panel's table. Each header is click-to-sort. Widths are
// percentages (table-layout: fixed) so columns stay readable and never overflow —
// Status is omitted because every row in a panel shares the panel's status.
const COLUMNS = [
  { key: "title", label: "Title", cls: "td-title", w: "23%" },
  { key: "company", label: "Company", w: "17%" },
  { key: "employmentType", label: "Type", w: "10%" },
  { key: "engagement", label: "Engage", w: "11%" },
  { key: "posted", label: "Posted", w: "10%" },
  { key: "band", label: "Match", w: "12%" },
];
// Wide enough for the primary action and Drop side by side (they used to stack).
const ACTIONS_W = "17%"; // widths + actions sum to 100% (table-layout: fixed)
// String columns default to ascending sort; numeric/date/band default to descending.
const SORT_ASC_DEFAULT = new Set(["title", "company", "location", "employmentType", "engagement", "status"]);

// Company cell: company name with the location stacked underneath, plus a flag when
// you've already applied to this company (so you can spot repeat employers at a glance).
function companyCell(job) {
  const kids = [el("div", { class: "company-name" }, job.company || "—")];
  if (job.location) kids.push(el("div", { class: "company-loc" }, job.location));
  if (job.appliedToCompany) kids.push(el("span", { class: "applied-flag", title: "You've already applied to this company" }, "✓ Applied here"));
  return el("div", { class: "company-cell" }, ...kids);
}

function cellContent(job, key) {
  switch (key) {
    case "title": return job.title || "(untitled)";
    case "company": return companyCell(job);
    case "location": return job.location || "—";
    case "employmentType": return ({ "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", casual: "Casual" }[job.employmentType]) || "—";
    case "engagement": return ({ permanent: "Permanent", contract: "Contract" }[job.engagement]) || "—";
    case "posted": return job.posted ? fmtDay(job.posted) : "—";
    case "closes": { const cl = closesLabel(job.closes); return cl ? cl.text : "—"; }
    case "band": return bandChip(job);
    case "status": return STATUS_LABEL[job.status] || job.status;
    default: return String(job[key] ?? "—");
  }
}

// ---- render: top bar --------------------------------------------------------
function renderTopbar(state) {
  if (state.version) $("#app-version").textContent = "v" + state.version;
  const s = state.scheduler;
  $("#sched").innerHTML = s.enabled
    ? `<div>next <b>${fmtTime(s.nextRun)}</b></div><div>last search ${fmtTime(s.lastRun)}</div>`
    : `<div>scheduler <b>off</b></div><div>last search ${fmtTime(s.lastRun)}</div>`;

  const key = $("#apikey");
  const up = state.ollama?.up;
  key.className = "dot-chip " + (up ? "on" : "off");
  key.title = up
    ? `Ollama up · ${state.ollama.model} (tailors resumes locally)`
    : "Ollama offline — start it to tailor resumes/cover letters";
}

// ---- render: board (full-width sortable tables, one per status panel) -------
function sortHeaderRow() {
  const tr = el("tr");
  for (const c of COLUMNS) {
    const active = sort.key === c.key;
    const th = el(
      "th",
      { class: (c.cls || "") + (active ? " sorted" : ""), title: "Sort by " + c.label },
      c.label,
      active ? el("span", { class: "sort-ind" }, sort.dir === "asc" ? "▲" : "▼") : null,
    );
    th.addEventListener("click", () => {
      if (sort.key === c.key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
      else sort = { key: c.key, dir: SORT_ASC_DEFAULT.has(c.key) ? "asc" : "desc" };
      if (lastState) renderBoard(lastState);
    });
    tr.append(th);
  }
  tr.append(el("th", { class: "th-actions" }, ""));
  return tr;
}

function renderRow(job) {
  const tr = el("tr", { class: job.autoRejected ? "row-rejected" : "" });
  tr.addEventListener("click", () => openDrawer(job.id));
  for (const c of COLUMNS) {
    const td = el("td", { class: c.cls || "" });
    td.append(cellContent(job, c.key));
    tr.append(td);
  }
  tr.append(actionsCell(job));
  return tr;
}

/**
 * Row actions: the column's primary action plus an explicit Drop button.
 *
 * This replaced a "move…" <select> holding every legal transition. A dropdown made the
 * common case — say no to a lead — a three-step interaction (open, read, pick) with a
 * mis-click landing you in a status you never wanted, and it hid Drop behind a menu on a
 * screen whose whole job is triage. The transitions that aren't one-click live in the
 * drawer, where there's room to explain them and to capture the applied date.
 */
function actionsCell(job) {
  const td = el("td", { class: "td-actions" });
  td.addEventListener("click", (e) => e.stopPropagation());
  const primary = PRIMARY[job.status];
  if (primary) {
    td.append(el("button", {
      class: "btn btn-sm icon-act " + (primary.kind === "primary" ? "btn-primary" : ""),
      title: primary.label,
      onclick: (e) => { e.stopPropagation(); primary.run(job.id); },
    }, primary.icon || primary.label));
  }
  const can = job.next || [];
  if (can.includes("dropped")) {
    td.append(el("button", {
      class: "btn btn-sm icon-act btn-danger",
      title: "Drop this opportunity",
      onclick: (e) => { e.stopPropagation(); post("/api/job/drop", { id: job.id }); },
    }, "✕"));
  }
  // Dropped is the one column with no primary action — restoring is the only move, and
  // without it here a dropped job could only be recovered by editing the vault note.
  if (job.status === "dropped" && can.includes("lead")) {
    td.append(el("button", {
      class: "btn btn-sm icon-act",
      title: "Restore to Opportunities",
      onclick: (e) => { e.stopPropagation(); post("/api/job/status", { id: job.id, status: "lead" }); },
    }, "↩"));
  }
  return td;
}

function renderBoard(state) {
  const board = $("#board");
  const prevY = board.scrollTop;
  board.innerHTML = "";
  board.removeAttribute("aria-busy");
  renderColMenu(state);

  for (const status of state.statusOrder) {
    if (!VIEW.statuses.includes(status)) continue; // shown on a different screen
    if (colVis[status] === false) continue; // panel hidden by user
    const all = state.board[status] || [];
    const rows = sortJobs(all.filter(matchesFilters));

    const headRight = el(
      "div",
      { class: "panel-head-right" },
      el("span", { class: "col-count" }, rows.length === all.length ? String(all.length) : `${rows.length}/${all.length}`),
    );
    // Opportunities panel hosts the "Refresh details" action (re-enrich descriptions).
    if (status === "lead") {
      const rb = el(
        "button",
        { class: "btn btn-sm btn-ghost col-refresh", title: "Re-fetch full descriptions for every job in Opportunities and update the ones that come back fuller" },
        "↻ Refresh details",
      );
      rb.addEventListener("click", (e) => { e.stopPropagation(); reenrichDetails(rb); });
      headRight.append(rb);
    }
    const panel = el(
      "div",
      { class: "panel", "data-status": status },
      el("div", { class: "panel-head" }, el("span", { class: "panel-name" }, STATUS_LABEL[status] || status), headRight),
    );
    const multiPanel = VIEW.statuses.length > 1;
    if (multiPanel && colWidths[status]) panel.style.flex = "0 0 " + colWidths[status] + "px";

    if (rows.length === 0) {
      panel.append(el("div", { class: "panel-empty" }, all.length ? "No matches in this view" : emptyHint(status)));
    } else {
      const table = el("table", { class: "jtable" });
      const colgroup = el("colgroup");
      for (const c of COLUMNS) colgroup.append(el("col", { style: "width:" + c.w }));
      colgroup.append(el("col", { style: "width:" + ACTIONS_W }));
      table.append(colgroup);
      table.append(el("thead", {}, sortHeaderRow()));
      const tbody = el("tbody");
      for (const job of rows) tbody.append(renderRow(job));
      table.append(tbody);
      panel.append(el("div", { class: "jtable-wrap" }, table));
    }
    if (multiPanel) panel.append(makePanelResizer(panel, status));
    board.append(panel);
  }
  board.scrollTop = prevY;
}

// ---- panels: show/hide + resize --------------------------------------------
let colVis = loadJSON("colVis", {});
let colWidths = loadJSON("colWidths", {});

function loadJSON(key, fallback) {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || "{}")) }; }
  catch { return { ...fallback }; }
}
function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

function renderColMenu(state) {
  const box = $("#col-toggles");
  if (!box) return;
  box.innerHTML = "";
  for (const status of state.statusOrder) {
    if (!VIEW.statuses.includes(status)) continue; // only panels on this screen
    const cb = el("input", { type: "checkbox" });
    cb.checked = colVis[status] !== false;
    cb.addEventListener("change", () => {
      colVis[status] = cb.checked;
      saveJSON("colVis", colVis);
      if (lastState) renderBoard(lastState);
    });
    box.append(el("label", {}, cb, STATUS_LABEL[status] || status));
  }
}

function makeColResizer(col, status) {
  const handle = el("div", { class: "col-resizer", title: "Drag to resize panel" });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(240, Math.min(720, startW + (ev.clientX - startX)));
      col.style.flexBasis = w + "px";
      colWidths[status] = Math.round(w);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      saveJSON("colWidths", colWidths);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  return handle;
}

// Drag the right edge of a panel to resize it; width persists per status in
// localStorage (colWidths). Only attached when a screen shows >1 panel.
function makePanelResizer(panel, status) {
  const handle = el("div", { class: "panel-resizer", title: "Drag to resize panel" });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(280, Math.min(1100, startW + (ev.clientX - startX)));
      panel.style.flex = "0 0 " + w + "px";
      colWidths[status] = Math.round(w);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      saveJSON("colWidths", colWidths);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  return handle;
}

function emptyHint(status) {
  if (status === "lead") return "Run a search to find jobs";
  if (status === "interested") return "Mark opportunities Interested to land here";
  if (status === "tailoring") return "Tailored docs appear here";
  if (status === "unsuccessful") return "Applied but not successful? Move jobs here from the Applied panel";
  return "—";
}

function bandChip(job) {
  const b = BAND[job.band] || BAND.weak;
  const sub = job.matchedCount ? `${job.matchedCount} skill${job.matchedCount === 1 ? "" : "s"}` : "no skill hits";
  return el(
    "div",
    { class: "band band-" + (job.band || "weak"), title: `Ranking: ${b.label} · ${sub}` },
    el("span", { class: "band-label" }, b.label),
    el("span", { class: "band-sub" }, sub),
  );
}

function badges(job) {
  const row = el("div", { class: "card-tags" });
  // Track first: a local IT role scores low against a senior-developer CV by design, so
  // the fit number alone tells you nothing about why it's on the board.
  if (job.track) {
    row.append(el("span", { class: "tag tag-track", title: `Found by the "${job.track}" search track` }, job.track));
  }
  if (job.source) row.append(el("span", { class: "tag tag-src" }, job.source));
  if (ENGAGEMENT_LABEL[job.engagement]) row.append(el("span", { class: "tag tag-eng" }, ENGAGEMENT_LABEL[job.engagement]));
  if (TYPE_LABEL[job.employmentType]) row.append(el("span", { class: "tag" }, TYPE_LABEL[job.employmentType]));
  if (job.workArrangement === "remote") row.append(el("span", { class: "tag tag-remote" }, "Remote"));
  else if (job.workArrangement === "hybrid") row.append(el("span", { class: "tag tag-hybrid" }, "Hybrid"));
  if (job.salary) row.append(el("span", { class: "tag" }, job.salary));
  if (job.posted) row.append(el("span", { class: "tag" }, "Posted " + fmtDay(job.posted)));
  if (job.expired) {
    row.append(el("span", { class: "tag warn" }, "⏳ expired"));
  } else {
    const cl = closesLabel(job.closes);
    if (cl) row.append(el("span", { class: "tag" + (cl.urgent ? " warn" : "") }, cl.text));
  }
  if (job.dropReason === "duplicate") {
    row.append(el("span", { class: "tag", title: job.duplicateOf ? "Duplicate of " + job.duplicateOf : "" }, "⧉ duplicate"));
  }
  if (job.applied) row.append(el("span", { class: "tag good" }, "✓ applied " + job.applied));
  else if (job.interested) row.append(el("span", { class: "tag good" }, "✓ interested"));
  if (job.autoRejected) row.append(el("span", { class: "tag warn" }, "auto-rejected"));
  return row;
}

function renderCard(job) {
  const meta = [job.company, job.location].filter(Boolean).join(" · ") || "—";

  const actions = el("div", { class: "card-actions" });
  const primary = PRIMARY[job.status];
  if (primary) {
    actions.append(
      el(
        "button",
        {
          class: "btn btn-sm " + (primary.kind === "primary" ? "btn-primary" : ""),
          onclick: (e) => {
            e.stopPropagation();
            primary.run(job.id);
          },
        },
        primary.label,
      ),
    );
  }
  // Drop sits next to the primary action (no "move…" menu — see actionsCell).
  if ((job.next || []).includes("dropped")) {
    actions.append(
      el("button", {
        class: "btn btn-sm btn-danger",
        title: "Drop this opportunity",
        onclick: (e) => { e.stopPropagation(); post("/api/job/drop", { id: job.id }); },
      }, "Drop"),
    );
  }
  if (job.status === "dropped" && (job.next || []).includes("lead")) {
    actions.append(
      el("button", {
        class: "btn btn-sm",
        title: "Restore to Opportunities",
        onclick: (e) => { e.stopPropagation(); post("/api/job/status", { id: job.id, status: "lead" }); },
      }, "↩ Restore"),
    );
  }

  const kids = [
    el("div", { class: "card-top" }, bandChip(job),
      el("div", { class: "card-head" },
        el("div", { class: "card-title" }, job.title),
        el("div", { class: "card-meta" }, meta))),
  ];
  if (job.summary) kids.push(el("div", { class: "card-summary" }, job.summary));
  kids.push(badges(job), actions);

  return el(
    "div",
    { class: "card" + (job.autoRejected ? " rejected" : ""), onclick: () => openDrawer(job.id) },
    ...kids,
  );
}

// ---- drawer (detail) --------------------------------------------------------
async function openDrawer(id) {
  let job;
  try {
    job = await getJSON("/api/job?id=" + encodeURIComponent(id));
  } catch (e) {
    return toast("Couldn't load job: " + e.message, false);
  }
  $("#drawer-title").textContent = job.title || "(untitled)";
  const fitEl = $("#drawer-fit");
  const band = job.autoRejected ? "rejected" : bandFromData(job);
  fitEl.className = "band band-" + band;
  fitEl.innerHTML = "";
  fitEl.append(
    el("span", { class: "band-label" }, (BAND[band] || BAND.weak).label),
    el("span", { class: "band-sub" }, typeof job.fit === "number" ? `fit ${job.fit}` : "unscored"),
  );

  const body = $("#drawer-body");
  body.innerHTML = "";

  const kv = (k, v) => el("div", { class: "kv" }, el("b", {}, k + ": "), v ?? "—");
  body.append(
    el("h3", {}, "Details"),
    kv("Company", job.company),
    kv("Location", job.location),
    kv("Engagement", ENGAGEMENT_LABEL[job.engagement] || "—"),
    kv("Employment", TYPE_LABEL[job.employmentType] || "—"),
    kv("Arrangement", ARRANGEMENT_LABEL[job.workArrangement] || "—"),
    kv("Salary", job.salary),
    kv("Source", job.source),
    kv("Status", STATUS_LABEL[job.status] || job.status),
    job.posted ? kv("Posted", fmtDay(job.posted)) : null,
    job.closes ? kv("Closes", fmtDay(job.closes) + (job.expired ? " (expired)" : "")) : null,
    job.applied ? kv("Applied", job.applied) : null,
    job.url ? el("div", { class: "kv" }, el("a", { class: "link", href: job.url, target: "_blank", rel: "noopener" }, "View posting ↗")) : null,
    kv("Scored", fmtTime(job.scored)),
  );

  if (job.rationale || job.matched?.length || job.missing?.length || job.autoRejected) {
    body.append(el("h3", {}, "Why this ranking"));
    if (job.rationale) body.append(el("div", { class: "kv" }, job.rationale));
    if (job.autoRejected && job.rejectReasons?.length)
      body.append(el("div", { class: "kv" }, el("b", {}, "Rejected: "), job.rejectReasons.join("; ")));
    if (job.matched?.length) {
      body.append(el("div", { class: "kv" }, el("b", {}, "Matched skills")));
      body.append(el("div", { class: "chips" }, ...job.matched.map((s) => el("span", { class: "tag" }, s))));
    }
    if (job.missing?.length) {
      body.append(el("div", { class: "kv" }, el("b", {}, "Missing")));
      body.append(el("div", { class: "chips" }, ...job.missing.map((s) => el("span", { class: "tag warn" }, s))));
    }
  }

  body.append(renderActionPanel(job));

  if (["interested", "tailoring", "applied", "unsuccessful"].includes(job.status)) {
    await appendDocs(body, job.id);
    await appendFilesList(body, job.id);
  }

  body.append(el("h3", {}, "Full description"));
  body.append(el("div", { class: "desc" }, descFromBody(job.body)));

  showDrawer(true);
}

// Tailored resume + cover letter, shown inline with tabs + copy for quick paste.
async function appendDocs(container, id) {
  let docs;
  try {
    docs = await getJSON("/api/job/docs?id=" + encodeURIComponent(id));
  } catch {
    return;
  }
  if (!docs || !docs.exists) return;

  const view = el("div", { class: "doc" });
  const copyBtn = el("button", { class: "btn btn-sm" }, "Copy");
  const tabs = el("div", { class: "doc-tabs" });
  let current = "cover";

  const set = (which) => {
    current = which;
    const md = (which === "cover" ? docs.cover : docs.resume) || "";
    view.innerHTML = md.trim() ? renderMarkdown(md) : "<p class='doc-empty'>(empty)</p>";
    for (const t of tabs.querySelectorAll(".doc-tab")) t.classList.toggle("active", t.dataset.k === which);
  };
  const tab = (k, label) => el("button", { class: "doc-tab", "data-k": k, onclick: () => set(k) }, label);

  copyBtn.addEventListener("click", () => {
    const text = current === "cover" ? docs.cover : docs.resume;
    navigator.clipboard.writeText(text || "").then(
      () => toast(`Copied ${current === "cover" ? "cover letter" : "resume"}`, true),
      () => toast("Copy failed", false),
    );
  });

  const exportBtn = (format, label) =>
    el("button", { class: "btn btn-sm", onclick: async () => {
      toast(`Generating ${label} with Word… (~10s)`, true, 30000);
      try {
        const r = await fetch("/api/job/convert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, doc: current, format }),
        });
        const d = await r.json();
        toast(d.message, d.ok);
      } catch (e) {
        toast("Convert failed: " + e.message, false);
      }
    } }, label);

  tabs.append(tab("cover", "Cover letter"), tab("resume", "Resume"), exportBtn("docx", ".docx"), exportBtn("pdf", "PDF"), copyBtn, revealBtn(id));

  const section = el("div", { class: "docs" }, el("h3", {}, "Tailored documents"), tabs, view);
  container.append(section);
  set("cover");
}

function bandFromData(job) {
  const fit = typeof job.fit === "number" ? job.fit : 0;
  if (fit >= 75) return "strong";
  if (fit >= 55) return "good";
  if (fit >= 35) return "fair";
  return "weak";
}

function renderActionPanel(job) {
  const box = el("div", { class: "panel" });
  if (job.status === "lead") {
    box.append(el("div", { class: "panel-note" }, "Want this one? Mark it Interested — the local model writes a tailored resume + cover letter into Career/Jobs/Applications/."));
    box.append(el("div", { class: "panel-actions" },
      el("button", { class: "btn btn-primary btn-sm", onclick: () => { interested(job.id).then(() => showDrawer(false)); } }, "⭐ Interested"),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => post("/api/job/drop", { id: job.id }).then(() => showDrawer(false)) }, "Drop"),
    ));
  } else if (job.status === "interested" || job.status === "tailoring") {
    box.append(el("div", { class: "panel-note" }, "Your tailored cover letter and resume are below — read them, copy what you need, then submit on the job site yourself. A resume.docx and cover-letter.docx are generated automatically; use 📂 Show files to download them or drag them onto the job site."));
    const actions = el("div", { class: "panel-actions" },
      el("button", { class: "btn btn-sm", onclick: () => interested(job.id).then(() => openDrawer(job.id)) }, "Re-tailor"),
      revealBtn(job.id),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => post("/api/job/drop", { id: job.id }).then(() => showDrawer(false)) }, "Drop"),
    );
    if (job.status === "tailoring") {
      // Applied yet? Capture the date and move it to the Applied column.
      const date = el("input", { type: "date", class: "date-input", value: new Date().toLocaleDateString("en-CA") });
      actions.append(
        date,
        el("button", { class: "btn btn-primary btn-sm", onclick: () => applyJob(job.id, date.value).then(() => showDrawer(false)) }, "✓ Mark Applied"),
      );
    }
    box.append(actions);
  } else if (job.status === "applied") {
    box.append(el("div", { class: "panel-note" }, job.applied
      ? `Applied on ${job.applied}. Recorded in the Obsidian note. Good luck.`
      : "Marked applied. Recorded in the Obsidian note."));
    box.append(el("div", { class: "panel-actions" },
      revealBtn(job.id),
      el("button", { class: "btn btn-sm", onclick: () => post("/api/job/status", { id: job.id, status: "tailoring" }).then(() => showDrawer(false)) }, "Back to Application Ready"),
      el("button", { class: "btn btn-sm btn-warn", onclick: () => post("/api/job/status", { id: job.id, status: "unsuccessful" }).then(() => showDrawer(false)) }, "✗ Mark Unsuccessful"),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => post("/api/job/drop", { id: job.id }).then(() => showDrawer(false)) }, "Drop"),
    ));
  } else if (job.status === "unsuccessful") {
    box.append(el("div", { class: "panel-note" }, job.applied
      ? `Applied on ${job.applied} — marked unsuccessful. Move it back if that changes.`
      : "Marked unsuccessful."));
    box.append(el("div", { class: "panel-actions" },
      revealBtn(job.id),
      el("button", { class: "btn btn-sm", onclick: () => post("/api/job/status", { id: job.id, status: "applied" }).then(() => showDrawer(false)) }, "↩ Reopen as Applied"),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => post("/api/job/drop", { id: job.id }).then(() => showDrawer(false)) }, "Drop"),
    ));
  } else if (job.status === "dropped") {
    // Dropped had no panel at all — the only way back was the "move…" menu, which is gone.
    box.append(el("div", { class: "panel-note" }, job.dropReason === "duplicate"
      ? `Dropped automatically as a duplicate${job.duplicateOf ? ` of ${job.duplicateOf}` : ""}. Restore it if that call was wrong.`
      : "Dropped. Restore it to Opportunities if you want another look."));
    box.append(el("div", { class: "panel-actions" },
      el("button", { class: "btn btn-primary btn-sm", onclick: () => post("/api/job/status", { id: job.id, status: "lead" }).then(() => showDrawer(false)) }, "↩ Restore to Opportunities"),
    ));
  }
  return box;
}

function descFromBody(body) {
  if (!body) return "(no description captured)";
  const i = body.indexOf("## Description");
  return (i >= 0 ? body.slice(i + "## Description".length) : body).trim() || "(no description captured)";
}

function showDrawer(open) {
  $("#drawer").hidden = !open;
  $("#scrim").hidden = !open;
}

// ---- toast ------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ok, ms = 5000) {
  // Route through the toastr-style notifier when present (notify.js).
  if (window.notify) { window.notify(ok ? "success" : "error", ok ? "Done" : "Error", msg, ms); return; }
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast " + (ok ? "ok" : "err");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---- filters wiring ---------------------------------------------------------
// Region select is filled once from NZ_REGIONS (keeps the leading "All NZ" option).
function populateRegions() {
  const sel = $("#f-region");
  if (sel.dataset.filled) return;
  for (const r of Object.keys(NZ_REGIONS)) sel.append(el("option", { value: r }, r));
  sel.dataset.filled = "1";
}
// District options depend on the chosen region; disabled when no region is selected.
function populateDistricts(region, selected = "") {
  const sel = $("#f-district");
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, "All"));
  for (const d of NZ_REGIONS[region] || []) sel.append(el("option", { value: d }, d));
  sel.value = selected;
  sel.disabled = !region;
}

function wireFilters() {
  const bind = (id, key, ev = "change") =>
    $(id).addEventListener(ev, (e) => {
      filters[key] = e.target.value.trim();
      if (lastState) renderBoard(lastState);
    });
  bind("#f-search", "search", "input");
  bind("#f-source", "source");
  bind("#f-type", "type");
  bind("#f-engagement", "engagement");
  bind("#f-remote", "remote");
  bind("#f-band", "band");
  // Sort dropdown is a quick preset for the table sort (column headers also sort).
  $("#f-sort").addEventListener("change", (e) => {
    filters.sort = e.target.value;
    sort = filters.sort === "newest" ? { key: "ingested", dir: "desc" } : { key: "fit", dir: "desc" };
    if (lastState) renderBoard(lastState);
  });

  populateRegions();
  $("#f-region").addEventListener("change", (e) => {
    filters.region = e.target.value;
    filters.district = ""; // reset district when the region changes
    populateDistricts(filters.region);
    if (lastState) renderBoard(lastState);
  });
  $("#f-district").addEventListener("change", (e) => {
    filters.district = e.target.value.trim();
    if (lastState) renderBoard(lastState);
  });

  $("#f-clear").addEventListener("click", () => {
    Object.assign(filters, FILTER_DEFAULTS);
    for (const id of ["#f-search", "#f-source", "#f-type", "#f-engagement", "#f-remote", "#f-band", "#f-region"]) $(id).value = "";
    $("#f-sort").value = "match";
    $("#f-preset").value = "";
    populateDistricts("");
    if (lastState) renderBoard(lastState);
  });
}

// ---- filter presets ---------------------------------------------------------
// Named filter sets stored in the Obsidian vault (Career/dashboard-presets.json) so
// they sync across machines. Applying one updates the board view AND, since filters
// drive the search, steers the next "Search jobs" run (see filterOverrides).
let presetCache = {};
function loadPresets() { return presetCache; }

async function loadPresetsFromServer() {
  try {
    const d = await getJSON("/api/presets");
    presetCache = (d && d.presets) || {};
  } catch {
    presetCache = {};
  }
  // One-time migration: lift any presets still in localStorage into the vault.
  if (Object.keys(presetCache).length === 0) {
    const local = loadJSON("filterPresets", {});
    if (Object.keys(local).length) { presetCache = local; await putPresets(); }
  }
  refreshPresetOptions();
}

async function putPresets() {
  try {
    await fetch("/api/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presets: presetCache }),
    });
  } catch (e) {
    toast("Couldn't save presets to vault: " + e.message, false);
  }
}

function refreshPresetOptions(selected = "") {
  const sel = $("#f-preset");
  const names = Object.keys(loadPresets()).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, names.length ? "— pick preset —" : "— no presets —"));
  for (const n of names) sel.append(el("option", { value: n }, n));
  sel.value = selected;
}

// Push the in-memory `filters` onto the toolbar controls (after applying a preset).
function applyFiltersToControls() {
  $("#f-search").value = filters.search || "";
  $("#f-source").value = filters.source || "";
  $("#f-type").value = filters.type || "";
  $("#f-engagement").value = filters.engagement || "";
  $("#f-remote").value = filters.remote || "";
  $("#f-region").value = filters.region || "";
  populateDistricts(filters.region || "", filters.district || "");
  $("#f-band").value = filters.band || "";
  $("#f-sort").value = filters.sort || "match";
  sort = (filters.sort === "newest") ? { key: "ingested", dir: "desc" } : { key: "fit", dir: "desc" };
}

// Map the current filters to backend search overrides. Only the fields the search
// pipeline understands are sent; band/remote/sort stay view-only.
function filterOverrides() {
  const o = {};
  if (filters.source) o.sites = [filters.source];
  if (filters.type === "full-time" || filters.type === "part-time") o.employmentType = filters.type;
  if (filters.engagement) o.engagement = filters.engagement;
  if (filters.search) o.keywords = filters.search;
  return o;
}

function wirePresets() {
  refreshPresetOptions();
  $("#f-preset").addEventListener("change", (e) => {
    const name = e.target.value;
    if (!name) return;
    const p = loadPresets()[name];
    if (!p) return;
    Object.assign(filters, FILTER_DEFAULTS, p);
    applyFiltersToControls();
    if (lastState) renderBoard(lastState);
    toast(`Applied preset “${name}” — it will also steer the next Search`, true);
  });
  $("#f-save").addEventListener("click", async () => {
    const name = prompt("Save current filters as preset named:");
    if (!name || !name.trim()) return;
    presetCache[name.trim()] = { ...filters };
    await putPresets();
    refreshPresetOptions(name.trim());
    toast(`Saved preset “${name.trim()}” to the vault`, true);
  });
  $("#f-del").addEventListener("click", async () => {
    const name = $("#f-preset").value;
    if (!name) return toast("Pick a preset to delete", false);
    delete presetCache[name];
    await putPresets();
    refreshPresetOptions("");
    toast(`Deleted preset “${name}”`, true);
  });
}

// ---- LOGS panel -------------------------------------------------------------
const LOG_LEVELS = ["info", "warn", "error", "debug"];
const logState = {
  entries: [],
  lastSeq: 0,
  filter: "",
  level: "",
  autoscroll: true,
  collapsed: localStorage.getItem("logsCollapsed") === "true",
};
const LOG_CAP = 3000;

function logMatches(e) {
  if (logState.level && e.level !== logState.level) return false;
  if (logState.filter && !e.msg.toLowerCase().includes(logState.filter)) return false;
  return true;
}
function fmtLogTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function renderLogs() {
  const body = $("#logs-body");
  if (!body) return;
  const rows = logState.entries.filter(logMatches);
  $("#logs-count").textContent = rows.length === logState.entries.length
    ? String(logState.entries.length)
    : `${rows.length}/${logState.entries.length}`;
  body.innerHTML = "";
  if (rows.length === 0) {
    body.append(el("div", { class: "logs-empty" }, logState.entries.length ? "No log lines match the filter" : "No logs yet — run a search to see activity"));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of rows) {
    frag.append(el("div", { class: "log-row log-" + e.level },
      el("span", { class: "log-ts" }, fmtLogTime(e.ts)),
      el("span", { class: "log-lvl" }, e.level),
      el("span", { class: "log-msg" }, e.msg),
    ));
  }
  body.append(frag);
  if (logState.autoscroll) body.scrollTop = body.scrollHeight;
}
async function pollLogs() {
  try {
    const { logs } = await getJSON("/api/logs?since=" + logState.lastSeq);
    if (logs && logs.length) {
      logState.entries.push(...logs);
      if (logState.entries.length > LOG_CAP) logState.entries.splice(0, logState.entries.length - LOG_CAP);
      logState.lastSeq = logs[logs.length - 1].seq;
      renderLogs();
    }
  } catch { /* server momentarily down; keep last view */ }
}
function setLogsCollapsed(collapsed) {
  logState.collapsed = collapsed;
  $("#logs").dataset.collapsed = String(collapsed);
  localStorage.setItem("logsCollapsed", String(collapsed));
}
function wireLogs() {
  setLogsCollapsed(logState.collapsed);
  const h = Number(localStorage.getItem("logsHeight"));
  if (h) $("#logs").style.height = h + "px";

  $("#logs-filter").addEventListener("input", (e) => { logState.filter = e.target.value.trim().toLowerCase(); renderLogs(); });
  $("#logs-level").addEventListener("change", (e) => { logState.level = e.target.value; renderLogs(); });
  $("#logs-autoscroll").addEventListener("change", (e) => { logState.autoscroll = e.target.checked; if (logState.autoscroll) renderLogs(); });
  $("#logs-toggle").addEventListener("click", () => setLogsCollapsed(!logState.collapsed));
  $("#logs-clear").addEventListener("click", async () => {
    await post("/api/logs/clear", {});
    logState.entries = [];
    logState.lastSeq = 0;
    renderLogs();
  });

  // Drag the top edge to resize the panel height.
  const resizer = $("#logs-resizer");
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (logState.collapsed) return;
    const startY = e.clientY;
    const startH = $("#logs").getBoundingClientRect().height;
    resizer.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const hh = Math.max(80, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY)));
      $("#logs").style.height = hh + "px";
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      localStorage.setItem("logsHeight", String(Math.round($("#logs").getBoundingClientRect().height)));
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
  });
}

// ---- search progress banner -------------------------------------------------
// A run takes minutes; the button alone told you nothing, so the server publishes its
// phase (/api/run-progress) and this renders it. Polled on the same tick as the logs, so
// a run started by the scheduler — or from another tab/phone — shows up here too.
const RUN_DONE_LINGER_MS = 30000; // how long the final "found N" line stays before self-hiding
const runBanner = { seq: -1, running: false, hideTimer: null };

/** "seek 42 · zeil 18 · linkedin: rate limited" — per-site detail under the headline. */
function bySiteLine(bySite) {
  const parts = Object.entries(bySite || {}).map(([site, r]) =>
    r.error ? `${site}: ${r.error}` : `${site} ${r.count}`,
  );
  return parts.join(" · ");
}

function showRunBanner(show) {
  const b = $("#run-banner");
  if (b) b.hidden = !show;
}

function renderRunProgress(p) {
  const b = $("#run-banner");
  if (!b || !p) return;

  // A new run (higher seq) cancels any lingering "done" line from the previous one.
  if (p.seq !== runBanner.seq) {
    runBanner.seq = p.seq;
    clearTimeout(runBanner.hideTimer);
    runBanner.hideTimer = null;
  }
  if (p.phase === "idle") { showRunBanner(false); runBanner.running = false; return; }

  const finished = !p.running;
  b.className = "run-banner" + (finished ? (p.error ? " err" : " ok") : "");
  $("#run-banner-spin").hidden = finished;
  $("#run-banner-msg").textContent = p.message || "Retrieving opportunities…";

  const sub = [];
  if (p.toScore) sub.push(`${p.scored}/${p.toScore} scored`);
  if (p.duplicates) sub.push(`${p.duplicates} already on the board`);
  const sites = bySiteLine(p.bySite);
  if (sites) sub.push(sites);
  $("#run-banner-sub").textContent = sub.join("  ·  ");

  // Found count gets its own emphasis — it is the number the user is waiting on.
  const count = $("#run-banner-count");
  count.hidden = !p.found;
  $("#run-banner-found").textContent = String(p.found);

  $("#run-banner-close").hidden = !finished;
  showRunBanner(true);

  // The Search button reflects the server, not this tab, so a run started elsewhere
  // can't be started twice.
  const btn = $("#run");
  if (btn) {
    btn.disabled = p.running;
    if (p.running) btn.textContent = "Searching…";
    else if (btn.textContent === "Searching…") btn.innerHTML = '<span class="play">▶</span> Search jobs';
  }

  // Run just ended: pull the new leads onto the board, then let the line linger a while.
  if (runBanner.running && finished) {
    refresh(true);
    runBanner.hideTimer = setTimeout(() => showRunBanner(false), RUN_DONE_LINGER_MS);
  }
  runBanner.running = p.running;
}

async function pollRunProgress() {
  try {
    renderRunProgress(await getJSON("/api/run-progress"));
  } catch { /* server momentarily down; keep the last view */ }
}

// ---- boot -------------------------------------------------------------------
// Cheap structural signature of the board — if the timer tick brings back the
// same data, skip re-rendering so we never disturb your scroll position / reading.
let lastBoardSig = "";
function boardSignature(state) {
  const parts = [];
  for (const s of state.statusOrder) {
    for (const j of state.board[s] || []) {
      parts.push(`${j.id}:${s}:${j.fit}:${j.band}:${j.applied || ""}:${j.expired ? 1 : 0}:${j.interested ? 1 : 0}:${j.appliedToCompany ? 1 : 0}`);
    }
  }
  return parts.join("|");
}

async function refresh(force = false) {
  try {
    const state = await getJSON("/api/state");
    lastState = state;
    window.watchState?.(state); // fire toastr notifications on changes
    renderTopbar(state);
    const sig = boardSignature(state);
    // Only rebuild the board when something actually changed (or on demand).
    if (force || sig !== lastBoardSig) {
      lastBoardSig = sig;
      renderBoard(state);
    }
  } catch (e) {
    toast("Load failed: " + e.message, false);
  }
}

$("#run").addEventListener("click", async () => {
  const btn = $("#run");
  btn.disabled = true;
  btn.textContent = "Searching…";
  // Show the banner immediately rather than waiting up to 3s for the next poll — the
  // click has to feel like it did something.
  renderRunProgress({ seq: runBanner.seq, running: true, phase: "starting", message: "Retrieving opportunities…", bySite: {} });
  // Start polling progress at a faster cadence for the duration of the run.
  const tick = setInterval(pollRunProgress, 2000);
  try {
    // Filters drive the search: send the search-relevant overrides (sites/type/
    // engagement/keywords) derived from the current filters / applied preset.
    await post("/api/run", { overrides: filterOverrides() });
  } finally {
    clearInterval(tick);
    await pollRunProgress(); // land the final "found N" line without waiting for the tick
    btn.disabled = false;
    if (btn.textContent === "Searching…") btn.innerHTML = '<span class="play">▶</span> Search jobs';
  }
});
$("#run-banner-close").addEventListener("click", () => {
  clearTimeout(runBanner.hideTimer);
  showRunBanner(false);
});
$("#drawer-close").addEventListener("click", () => showDrawer(false));
$("#scrim").addEventListener("click", () => showDrawer(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") showDrawer(false);
});

// Close the Panels menu when clicking elsewhere.
document.addEventListener("click", (e) => {
  const menu = $("#col-menu");
  if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
});

// Left-menu action items (search / refresh / toggle-logs).
for (const a of document.querySelectorAll(".nav a[data-action]")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const act = a.dataset.action;
    if (act === "search") $("#run").click();
    else if (act === "refresh") reenrichDetails();
    else if (act === "toggle-logs") setLogsCollapsed(!logState.collapsed);
  });
}

// Scope this screen to its VIEW: ribbon title, browser tab title, and hide the
// Search jobs button anywhere except Opportunities (it only pulls new leads).
{
  const rh = $("#ribbon-here");
  if (rh) rh.textContent = VIEW.title;
  document.title = "Career OS · " + VIEW.title;
  const runBtn = $("#run");
  if (runBtn && !VIEW.statuses.includes("lead")) runBtn.style.display = "none";
}

// Pull-to-refresh: pull down at the top of the board to re-fetch. Touch only (no-op with a
// mouse). The app-shell scrolls inside #board, not the document, which disables the browser's
// native pull-to-refresh — this restores the gesture that phone users expect.
function initPullToRefresh() {
  const THRESHOLD = 70; // px pulled before a release triggers a refresh
  const HEIGHT = 46; // keep in sync with .ptr height
  const MAX = 120; // clamp the visual pull distance
  const ind = el("div", { class: "ptr" },
    el("span", { class: "ptr-spin" }, "↓"),
    el("span", { class: "ptr-text" }, "Pull to refresh"),
  );
  document.body.appendChild(ind);
  const text = ind.querySelector(".ptr-text");
  const scroller = () => document.querySelector("#board") || document.querySelector(".home");
  let startY = 0, pulling = false, dragged = 0, busy = false;

  const reset = () => {
    ind.style.transition = "transform 0.2s ease";
    ind.style.transform = "translateY(-100%)";
    ind.classList.remove("ready", "loading");
    text.textContent = "Pull to refresh";
  };

  document.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || e.target.closest("#drawer")) { pulling = false; return; }
    const sc = scroller();
    if (!sc || sc.scrollTop > 0) { pulling = false; return; }
    startY = e.touches[0].clientY;
    dragged = 0;
    pulling = true;
    ind.style.transition = "none";
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    dragged = e.touches[0].clientY - startY;
    if (dragged <= 0) { ind.style.transform = "translateY(-100%)"; ind.classList.remove("ready"); return; }
    const shown = Math.min(dragged, MAX);
    ind.style.transform = `translateY(${shown - HEIGHT}px)`;
    const ready = dragged >= THRESHOLD;
    ind.classList.toggle("ready", ready);
    text.textContent = ready ? "Release to refresh" : "Pull to refresh";
  }, { passive: true });

  document.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (dragged < THRESHOLD) { reset(); return; }
    busy = true;
    ind.style.transition = "transform 0.2s ease";
    ind.style.transform = "translateY(0)";
    ind.classList.add("loading");
    ind.classList.remove("ready");
    text.textContent = "Refreshing…";
    try { await refresh(); } catch { /* ignore refresh errors */ }
    setTimeout(() => { reset(); busy = false; }, 350);
  });
}

wireFilters();
wirePresets();
loadPresetsFromServer();
wireLogs();
initPullToRefresh();
refresh();
pollLogs();
pollRunProgress();
setInterval(refresh, 30000); // light auto-refresh for scheduler/last-run
setInterval(pollLogs, 3000); // stream new server log lines into the LOGS panel
setInterval(pollRunProgress, 3000); // drive the "retrieving opportunities" banner
