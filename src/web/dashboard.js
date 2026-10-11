// Career OS — home Dashboard: SmartAdmin-style stat tiles + status cards.
// Read-only overview of the pipeline; the board lives on /opportunities.
const $ = (sel, root = document) => root.querySelector(sel);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL = {
  lead: "Opportunities",
  interested: "Interested",
  tailoring: "Application Ready",
  applied: "Applied",
  unsuccessful: "Unsuccessful",
};
// Tile: [status, SmartAdmin tone, target screen].
const TILES = [
  ["lead", "smart", "/opportunities"],
  ["interested", "blue", "/opportunities"],
  ["tailoring", "purple", "/application-ready"],
  ["applied", "green", "/applied"],
  ["unsuccessful", "maroon", "/unsuccessful"],
];

function el(tag, attrs = {}, html = "") {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (v != null) n.setAttribute(k, v);
  }
  if (html) n.innerHTML = html;
  return n;
}

function renderHeaderChips(s) {
  const sc = s.scheduler || {};
  const sched = $("#sched");
  if (sched) {
    sched.innerHTML = sc.enabled
      ? `<div>next <b>${fmtTime(sc.nextRun)}</b></div><div>${sc.mode === "interval" ? `every ${sc.intervalMinutes}m` : `daily ${sc.time}`}</div>`
      : `<div>scheduler <b>off</b></div><div>last ${fmtTime(sc.lastRun)}</div>`;
  }
  const dot = $("#apikey");
  if (dot) {
    const up = s.ollama && s.ollama.up;
    dot.className = "dot-chip " + (up ? "on" : "off");
    dot.title = up ? `Ollama up · ${s.ollama.model}` : "Ollama offline — start it for local AI";
  }
}

async function load() {
  let s;
  try {
    s = await getJSON("/api/state");
  } catch {
    return;
  }
  window.watchState?.(s); // fire toastr notifications on changes
  if (s.version) $("#app-version").textContent = "v" + s.version;

  const tiles = $("#tiles");
  tiles.innerHTML = "";
  for (const [key, tone, href] of TILES) {
    const n = (s.counts && s.counts[key]) ?? 0;
    const a = el("a", { class: `tile tile-${tone}`, href },
      `<div class="tile-num">${n}</div><div class="tile-label">${STATUS_LABEL[key]}</div>`);
    tiles.append(a);
  }

  const sc = s.scheduler || {};
  $("#sched-tile").innerHTML = sc.enabled
    ? `<b>On</b> — ${sc.mode === "interval" ? `every ${sc.intervalMinutes} min` : `daily at ${sc.time}`}<br><small>next ${fmtTime(sc.nextRun)}</small>`
    : `<b>Off</b><br><small>last run ${fmtTime(sc.lastRun)}</small>`;

  const up = s.ollama && s.ollama.up;
  $("#ollama-tile").innerHTML = up
    ? `<b>Up</b><br><small>${s.ollama.model || ""}</small>`
    : `<b>Offline</b><br><small>start Ollama for local scoring/tailoring</small>`;

  renderHeaderChips(s);
}

load();
setInterval(load, 30000);
