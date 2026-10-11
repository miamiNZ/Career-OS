// Career OS — Admin page (scheduler settings). Vanilla ESM, no build step.
const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer = null;
function toast(msg, ok = true, ms = 4000) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + (ok ? "ok" : "err");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}
async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "interval";
}

// Enable only the inputs relevant to the chosen mode.
function syncDisabled() {
  const m = selectedMode();
  $("#interval-value").disabled = m !== "interval";
  $("#interval-unit").disabled = m !== "interval";
  $("#time").disabled = m !== "daily";
}

function renderStatus(s) {
  $("#sched-status").textContent = s.enabled
    ? `${s.mode === "interval" ? `Every ${s.intervalMinutes} min` : `Daily at ${s.time}`} · next ${fmtTime(s.nextRun)} · last run ${fmtTime(s.lastRun)}`
    : `Scheduler off · last run ${fmtTime(s.lastRun)}`;
}

function fill(s) {
  $("#enabled").checked = !!s.enabled;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  if (!document.querySelector('input[name="mode"]:checked')) {
    document.querySelector('input[name="mode"][value="interval"]').checked = true;
  }
  $("#time").value = s.time || "08:00";
  // Show whole hours as hours, otherwise minutes.
  const mins = Number(s.intervalMinutes) || 60;
  if (mins % 60 === 0 && mins >= 60) {
    $("#interval-value").value = mins / 60;
    $("#interval-unit").value = "hours";
  } else {
    $("#interval-value").value = mins;
    $("#interval-unit").value = "minutes";
  }
  renderStatus(s);
  syncDisabled();
}

async function load() {
  try {
    fill(await getJSON("/api/scheduler"));
  } catch (e) {
    toast("Couldn't load scheduler: " + e.message, false);
  }
}

$("#sched-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unit = $("#interval-unit").value;
  const val = Math.max(1, parseInt($("#interval-value").value, 10) || 1);
  const body = {
    enabled: $("#enabled").checked,
    mode: selectedMode(),
    time: $("#time").value || "08:00",
    intervalMinutes: unit === "hours" ? val * 60 : val,
  };
  const d = await post("/api/scheduler", body);
  if (d.scheduler) fill(d.scheduler);
  toast(d.message || "Saved", d.ok !== false);
});

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener("change", syncDisabled);
}

$("#run-now").addEventListener("click", async () => {
  toast("Search started — watch the dashboard LOGS panel", true, 6000);
  await post("/api/run", {});
  load();
});

load();
