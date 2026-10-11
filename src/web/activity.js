// Activity screen: one table of everything long-running — the search run and each tailoring
// job — with the step it is on, a progress bar and an estimated time left.
//
// Polls rather than streams. The data is a handful of rows and the server already holds it in
// memory, so a 2s poll costs less than the plumbing an SSE/WebSocket channel would need, and
// it recovers on its own if the server restarts mid-run.

const POLL_MS = 2000;

const rowsEl = document.querySelector("#act-rows");
const emptyEl = document.querySelector("#act-empty");
const summaryEl = document.querySelector("#act-summary");
const totalEl = document.querySelector("#act-total");
const bulkEl = document.querySelector("#act-bulk");
const bulkNEl = document.querySelector("#act-bulk-n");
const allEl = document.querySelector("#act-all");

/**
 * Ids the user has ticked. Held outside render() so a selection survives the 2s poll —
 * re-rendering the table from scratch would otherwise clear the checkboxes under them.
 */
const selected = new Set();
/** Latest payload, so a bulk action knows each task's state without re-fetching. */
let current = [];

const KIND_ICON = { search: "🔎", tailor: "✎", convert: "📄" };
const KIND_LABEL = { search: "Search", tailor: "Tailor", convert: "Convert" };

/** mm:ss (or h:mm:ss past an hour), matching how the rest of the app shows durations. */
function fmtDuration(secs) {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Wall-clock seconds a task has taken: start to finish, or start to now while it is still
 * running. Computed here rather than served as a number so a running row keeps counting up
 * between polls instead of freezing at whatever the last payload said.
 */
function elapsedSeconds(t) {
  const start = Date.parse(t.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = t.finishedAt ? Date.parse(t.finishedAt) : Date.now();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

function progressCell(task) {
  const pct = Math.round((task.progress ?? 0) * 100);
  // A finished task shows a full bar in its terminal colour rather than an empty track, so
  // the row still reads as "this happened" once it stops moving.
  const bar = el("div", { class: `act-bar act-bar-${task.state}` },
    el("div", { class: "act-bar-fill", style: `width:${pct}%` }),
  );
  return el("div", { class: "act-prog" }, bar, el("span", { class: "act-pct" }, `${pct}%`));
}

function stateChip(task) {
  const label = {
    running: "Running",
    queued: "Queued",
    done: "Done",
    error: "Failed",
    cancelled: "Cancelled",
  }[task.state] ?? task.state;
  return el("span", { class: `act-chip act-chip-${task.state}`, title: task.error || task.message || "" }, label);
}

/** Last in-flight count we told the nav about, so we only nudge it when it actually moves. */
let lastActive = -1;

function render(tasks) {
  current = tasks;
  rowsEl.replaceChildren();
  const running = tasks.filter((t) => t.state === "running").length;
  // This page polls every 2s and the nav every 15s; when a task starts or finishes under us,
  // hand the nav the news rather than letting its badge sit stale for up to 15 seconds.
  const active = tasks.filter((t) => t.state === "running" || t.state === "queued").length;
  if (active !== lastActive) {
    lastActive = active;
    window.dispatchEvent(new CustomEvent("careeros:counts-stale"));
  }
  emptyEl.hidden = tasks.length > 0;
  summaryEl.textContent = tasks.length
    ? `${running} running · ${tasks.length} total`
    : "Idle";
  totalEl.textContent = `Total records: ${tasks.length}`;

  // Drop selections for rows that have since gone (dismissed, or pruned from the registry).
  const live = new Set(tasks.map((t) => t.id));
  for (const id of [...selected]) if (!live.has(id)) selected.delete(id);

  for (const t of tasks) {
    const canCancel = t.state === "running" || t.state === "queued";
    // The search run is a singleton owned by the pipeline, not a cancellable task — offering
    // an × that silently does nothing would be worse than not offering one.
    const dismissable = t.kind !== "search" || !canCancel;
    const step = t.steps?.length ? `${Math.min(t.stepIndex + 1, t.steps.length)}/${t.steps.length}` : "—";

    // No checkbox on the search run: it is not cancellable, and "select all" skips it, so a
    // tickable box would offer an action that quietly does nothing.
    const check = t.kind === "search" ? null : el("input", { type: "checkbox", class: "act-check" });
    if (check) {
      check.checked = selected.has(t.id);
      check.addEventListener("change", () => {
        if (check.checked) selected.add(t.id);
        else selected.delete(t.id);
        syncBulk();
      });
    }

    rowsEl.append(
      el("tr", { class: t.state === "running" ? "act-row-live" : "" },
        el("td", { class: "act-td-check" }, check),
        el("td", { class: "act-td-ico", title: KIND_LABEL[t.kind] ?? t.kind }, KIND_ICON[t.kind] ?? "•"),
        el("td", { class: "td-title" }, t.title || "—"),
        el("td", { class: "act-td-detail" }, t.subtitle || ""),
        el("td", { class: "act-td-step" }, step),
        el("td", {}, stateChip(t)),
        el("td", { class: "act-td-eta" }, t.state === "running" ? fmtDuration(t.etaSeconds) : "—"),
        el(
          "td",
          {
            class: t.state === "running" ? "act-td-took is-live" : "act-td-took",
            title: t.finishedAt ? `Finished ${new Date(t.finishedAt).toLocaleString()}` : "Still running",
          },
          fmtDuration(elapsedSeconds(t)),
        ),
        el("td", { class: "act-td-prog" }, progressCell(t)),
        el("td", { class: "td-actions" },
          dismissable
            ? el("button", {
                class: "btn btn-sm icon-act act-x",
                title: canCancel ? "Cancel this task" : "Remove from the list",
                onclick: async () => {
                  await post(canCancel ? "/api/activity/cancel" : "/api/activity/dismiss", { taskId: t.id });
                  await tick();
                },
              }, "×")
            : null,
        ),
      ),
    );
  }
}

/** Show the bulk bar only when something is ticked, and keep the header box in step. */
function syncBulk() {
  bulkEl.hidden = selected.size === 0;
  bulkNEl.textContent = `${selected.size} selected`;
  const selectable = current.filter((t) => t.kind !== "search").length;
  allEl.checked = selectable > 0 && selected.size >= selectable;
}

allEl?.addEventListener("change", () => {
  selected.clear();
  // The search run is not a task anyone can cancel, so "select all" skips it rather than
  // ticking a row whose action would silently do nothing.
  if (allEl.checked) for (const t of current) if (t.kind !== "search") selected.add(t.id);
  render(current);
  syncBulk();
});

document.querySelector("#act-bulk-go")?.addEventListener("click", async () => {
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const id of [...selected]) {
    const t = byId.get(id);
    if (!t) continue;
    const running = t.state === "running" || t.state === "queued";
    await post(running ? "/api/activity/cancel" : "/api/activity/dismiss", { taskId: id });
  }
  selected.clear();
  syncBulk();
  await tick();
});

// The gear clears every finished row at once — the common case after a batch of tailoring.
document.querySelector("#act-clear")?.addEventListener("click", async () => {
  for (const t of current) {
    if (t.kind === "search") continue;
    if (t.state !== "running" && t.state !== "queued") await post("/api/activity/dismiss", { taskId: t.id });
  }
  await tick();
});

let timer = null;

async function tick() {
  try {
    const r = await fetch("/api/activity");
    const data = await r.json();
    render(Array.isArray(data.tasks) ? data.tasks : []);
    syncBulk();
  } catch {
    summaryEl.textContent = "Dashboard unreachable";
  }
}

// Pause polling while the tab is hidden: a background tab hitting the vault-backed server
// every 2s for hours is pure waste, and the first poll on return re-syncs anyway.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(timer);
    timer = null;
  } else if (!timer) {
    tick();
    timer = setInterval(tick, POLL_MS);
  }
});

tick();
timer = setInterval(tick, POLL_MS);
