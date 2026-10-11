// Toastr-style stacked notifications (top-right), vanilla — no jQuery/toastr dep.
// Exposes window.notify(type, title, msg) and window.watchState(state), which fires
// notifications when the polled /api/state changes (new opportunities, scheduler
// result, application ready). Loaded before the page script on every screen.

function ensureHost() {
  let h = document.getElementById("toastr-host");
  if (!h) {
    h = document.createElement("div");
    h.id = "toastr-host";
    h.className = "toastr-host";
    document.body.appendChild(h);
  }
  return h;
}

function notify(type, title, msg, ms = 6000) {
  const host = ensureHost();
  const n = document.createElement("div");
  n.className = "toastr toastr-" + (type || "info");
  const t = document.createElement("div");
  t.className = "toastr-title";
  t.textContent = title || "";
  const m = document.createElement("div");
  m.className = "toastr-msg";
  m.textContent = msg || "";
  if (title) n.appendChild(t);
  if (msg) n.appendChild(m);
  n.addEventListener("click", () => n.remove());
  host.appendChild(n);
  if (ms > 0) {
    setTimeout(() => {
      n.classList.add("toastr-out");
      setTimeout(() => n.remove(), 250);
    }, ms);
  }
  return n;
}
window.notify = notify;

// Change detection across /api/state polls. Skips the first call (baseline) so we
// don't notify for the state that already existed when the page loaded.
let prev = null;
function watchState(state) {
  const counts = (state && state.counts) || {};
  const sc = (state && state.scheduler) || {};
  const cur = {
    lead: counts.lead || 0,
    tailoring: counts.tailoring || 0,
    lastRun: sc.lastRun || null,
    lastError: sc.lastError || null,
  };

  if (prev) {
    const newLeads = cur.lead - prev.lead;
    if (newLeads > 0) {
      notify("info", "New opportunities", `${newLeads} new opportunit${newLeads === 1 ? "y" : "ies"} found`);
    }
    const newReady = cur.tailoring - prev.tailoring;
    if (newReady > 0) {
      notify("success", "Application ready", `${newReady} application${newReady === 1 ? "" : "s"} ready to review`);
    }
    if (cur.lastError && cur.lastError !== prev.lastError) {
      notify("error", "Scheduled search failed", cur.lastError, 0);
    } else if (cur.lastRun && cur.lastRun !== prev.lastRun) {
      const r = sc.lastResult || {};
      notify("success", "Scheduled search done", `${r.found ?? 0} found · ${r.kept ?? 0} kept`);
    }
  }
  prev = cur;
}
window.watchState = watchState;
