// Shared SmartAdmin shell: builds the left menu, marks the active item, and wires
// the collapse toggles (header hamburger + bottom minify button). Loaded before the
// page script (modules → DOM is parsed before this runs).
const NAV_KEY = "navCollapsed";
if (localStorage.getItem(NAV_KEY) === "true") document.body.classList.add("nav-collapsed");

// `count` names the board statuses a badge sums. It mirrors the VIEWS map in app.js — a
// badge has to count exactly what the page it links to renders, or it lies about the number.
// "activity" is the live in-flight count instead, which comes from the same endpoint.
const MENU = [
  { section: "Navigation" },
  { href: "/", ico: "▦", label: "Dashboard" },
  { href: "/opportunities", ico: "▤", label: "Opportunities", count: ["lead", "interested"] },
  { href: "/application-ready", ico: "✎", label: "Application Ready", count: ["tailoring"] },
  { href: "/applied", ico: "✔", label: "Applied", count: ["applied"] },
  { href: "/unsuccessful", ico: "✗", label: "Unsuccessful", count: ["unsuccessful"] },
  { href: "/dropped", ico: "🗑", label: "Dropped", count: ["dropped"] },
  { section: "Settings" },
  { href: "/activity", ico: "◐", label: "Activity", count: "activity" },
  { href: "/admin", ico: "⏱", label: "Scheduler" },
];

const list = document.querySelector("#nav-list");
if (list) {
  const here = location.pathname.replace(/\/+$/, "") || "/";
  for (const m of MENU) {
    const li = document.createElement("li");
    if (m.section) {
      li.className = "nav-section";
      li.textContent = m.section;
      list.append(li);
      continue;
    }
    const a = document.createElement("a");
    a.href = m.href;
    a.innerHTML =
      `<span class="nav-ico">${m.ico}</span><span class="nav-label">${m.label}</span>` +
      (m.count ? `<span class="nav-count" data-count="${m.href}" hidden></span>` : "");
    if (m.href === here) li.className = "active";
    li.append(a);
    list.append(li);
  }
}

// Any .js-nav-toggle collapses/expands the menu (header hamburger + minify button).
for (const t of document.querySelectorAll(".js-nav-toggle")) {
  t.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("nav-collapsed");
    try { localStorage.setItem(NAV_KEY, String(collapsed)); } catch {}
  });
}

// ── Badge counts ─────────────────────────────────────────────────────────────
// Polled from /api/counts, which only tallies — /api/state serializes the whole board and
// reconciles the vault, far too heavy to run on every page just to render six numbers.
const COUNT_POLL_MS = 15000;

function paintCounts(data) {
  const counts = data?.counts ?? {};
  for (const m of MENU) {
    if (!m.count) continue;
    const badge = document.querySelector(`.nav-count[data-count="${m.href}"]`);
    if (!badge) continue;

    if (m.count === "activity") {
      const n = Number(data?.activity ?? 0);
      // Activity is a live signal, not an inventory: a "0" badge on an idle app is noise,
      // so it only appears when something is actually running.
      badge.hidden = n === 0;
      badge.textContent = String(n);
      badge.classList.add("nav-count-live");
      badge.title = `${n} task${n === 1 ? "" : "s"} running`;
      continue;
    }

    const n = m.count.reduce((sum, s) => sum + (Number(counts[s]) || 0), 0);
    // Board counts are standing inventory — show them even at zero, so an empty column is
    // stated rather than left ambiguous.
    badge.hidden = false;
    badge.textContent = String(n);
    badge.title = `${n} job${n === 1 ? "" : "s"}`;
  }
}

async function refreshCounts() {
  try {
    const r = await fetch("/api/counts");
    if (!r.ok) return;
    paintCounts(await r.json());
  } catch {
    // Dashboard unreachable — leave the last known numbers rather than flashing zeros,
    // which would read as "everything disappeared".
  }
}

let countTimer = null;

function startCountPolling() {
  if (countTimer) return;
  refreshCounts();
  countTimer = setInterval(refreshCounts, COUNT_POLL_MS);
}

// Same reasoning as the Activity screen's poll: a hidden tab does not need to keep asking.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(countTimer);
    countTimer = null;
  } else {
    startCountPolling();
  }
});

startCountPolling();

// A board action (Interested, Drop, status change) changes the counts immediately; waiting up
// to 15s to reflect that makes the badge look broken. Page scripts fire this after a mutation.
window.addEventListener("careeros:counts-stale", refreshCounts);
