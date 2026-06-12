"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / disabled */ } };
const SEVS = ["critical", "high", "medium", "low"];
// Archived repos drop out of GitHub's alert feed entirely, so there's no archived
// tab. "Pending PR" holds repos with an open update PR from this tool, awaiting merge.
const TABS = [
  { key: "untriaged", label: "Untriaged" },
  { key: "maintained", label: "Maintained" },
  { key: "pending", label: "Pending PR" },
  { key: "covered", label: "Covered" },
  { key: "monitored", label: "Monitored" },
  { key: "notified", label: "Notified" },
  { key: "compliance", label: "🛡 Compliance" },
  { key: "ignored", label: "Ignored" },
];
// Tabs that only appear once they hold something (resting/catch-all buckets).
const HIDE_WHEN_EMPTY = new Set(["untriaged", "covered"]);
// Engagement (Track-as) states + action labels — MUST match lib/state.js VALID (the
// /api/classify contract). NOTE: TABS above intentionally uses different display text
// ("Maintained" vs "Maintain"); do not derive one from the other.
const ENGAGEMENTS = [["maintained", "Maintain"], ["monitored", "Monitor"], ["ignored", "Ignore"]];
const ENG_LABEL = Object.fromEntries(ENGAGEMENTS);
const ENG_RANK = Object.fromEntries(ENGAGEMENTS.map(([k], i) => [k, i]));
// The Compliance tab is its own full-org inventory (not driven by the alert model).
let STATE = { model: null, tab: "maintained", maxConcurrent: 3, ciStatus: {}, autoFixCI: false, maxAttempts: 2, eol: {}, autoUpgradeEOL: false, protection: {}, complianceData: null, complianceFilter: lsGet("compliance.filter", "all"), compSearch: lsGet("compliance.search", ""), compSort: { key: lsGet("compliance.sortKey", ""), dir: Number(lsGet("compliance.sortDir", "1")) || 1 }, alertSearch: "", compRows: [], compCursor: 0, compSelected: new Set() };
// Background update jobs, keyed by repo. Progress arrives over the global
// /api/events stream and is buffered here so a tab switch / re-render (or a full
// page reload) can rebuild each card's live log.
const JOBS = new Map(); // repo -> { jobId, status, events: [] }

// ---- utils ------------------------------------------------------------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function relTime(iso) {
  if (!iso) return "unknown";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(days) < 1) return "today";
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  if (Math.abs(days) < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}

// POST JSON to an API route; resolves the parsed response body. On a non-OK response
// throws an Error carrying .status and .data (parsed error body) so call sites can
// branch on e.g. the 412 needsScope replies without re-rolling fetch boilerplate.
async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `server returned ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// GET an API route as JSON. Unlike the old inline `(await fetch(u)).json()` idiom this
// checks res.ok, so pollers keep their previous state on an error response instead of
// clobbering it with an error body's empty fields.
async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `server returned ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// ---- custom confirmation modal ---------------------------------------------
// Promise<boolean> replacement for window.confirm/prompt. The first paragraph of
// `message` becomes the title, the rest the body. opts:
//   danger        → red confirm button + danger framing
//   confirmLabel  → confirm button text (default "Confirm")
//   requireMatch  → shows an input and keeps the confirm button DISABLED until the
//                   typed value matches this string exactly (GitHub-style delete gate)
function confirmModal(opts = {}) {
  const { message = "", danger = false, confirmLabel = "Confirm", cancelLabel = "Cancel", requireMatch = null, rememberKey = null } = opts;
  // If the user previously ticked "don't ask again" for this action, skip the modal.
  if (rememberKey && localStorage.getItem("confirmSkip:" + rememberKey) === "1") return Promise.resolve(true);
  // Typed-confirm modal (delete): pre-copy the value to the clipboard so it can be pasted
  // straight into the field. Runs inside the originating click/keypress gesture.
  if (requireMatch && navigator.clipboard) { try { navigator.clipboard.writeText(requireMatch); } catch { /* clipboard blocked */ } }
  const parts = String(message).split(/\n\n+/).filter((p) => p.trim() !== "");
  const title = opts.title != null ? opts.title : parts.shift() || "Are you sure?";
  // opts.html (trusted, app-built markup) renders verbatim; otherwise the plain message
  // is escaped and paragraph/line-broken.
  const bodyHtml =
    opts.html != null
      ? opts.html
      : parts.map((p) => `<p>${p.split("\n").map((l) => esc(l)).join("<br>")}</p>`).join("");
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-overlay";
    overlay.innerHTML =
      `<div class="modal confirm${danger ? " danger" : ""}" role="dialog" aria-modal="true">` +
      `<div class="modal-title">${esc(title)}</div>` +
      `<div class="modal-body">${bodyHtml}` +
      (requireMatch
        ? `<label class="modal-match-label">Paste or type <code>${esc(requireMatch)}</code> to confirm <span class="match-copied">· copied to clipboard</span></label>` +
          `<input class="modal-match" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`
        : "") +
      `</div>` +
      `<div class="modal-actions">` +
      (rememberKey ? `<label class="modal-remember"><input type="checkbox" class="modal-remember-cb"> Don't ask again</label>` : "") +
      (cancelLabel === null ? "" : `<button class="modal-cancel subtle">${esc(cancelLabel)}</button>`) +
      `<button class="modal-confirm ${danger ? "danger" : "primary"}"${requireMatch ? " disabled" : ""}>${esc(confirmLabel)}</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".modal-match");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const commit = () => {
      if (confirmBtn.disabled) return;
      if (rememberKey) {
        const cb = overlay.querySelector(".modal-remember-cb");
        if (cb && cb.checked) localStorage.setItem("confirmSkip:" + rememberKey, "1");
      }
      close(true);
    };
    const close = (val) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      // The modal fully owns Esc/Enter while open — stopPropagation so the event
      // doesn't reach the bubble-phase global handlers (which would otherwise see the
      // overlay already removed and run their own Esc, e.g. clearing the selection).
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter" && !confirmBtn.disabled && document.activeElement !== cancelBtn) { e.preventDefault(); e.stopPropagation(); commit(); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(false); });
    if (cancelBtn) cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", commit);
    if (input) {
      input.addEventListener("input", () => { confirmBtn.disabled = input.value !== requireMatch; });
      setTimeout(() => input.focus(), 30);
    } else {
      setTimeout(() => confirmBtn.focus(), 30);
    }
  });
}

// ---- partitioning (the single source of truth for tabs + counts) ------------
function partition() {
  const repos = (STATE.model && STATE.model.repos) || [];
  const active = repos.filter((r) => !r.archived);
  const cls = (r) => r.classification || "untriaged";
  const notifiedCurrent = (r) => r.notifiedAt && !(r.newAdvisoryCount > 0);
  // A maintained gem whose constraints already permit every patch needs no action —
  // it rests in "Covered" instead of cluttering the active Maintained worklist.
  const covered = (r) => r.disposition && r.disposition.state === "covered";
  // An open PR takes FULL precedence: a pending repo stays in "Pending PR" no matter
  // its classification (so reclassifying it doesn't move it out — classification just
  // decides which tab it lands in once the PR merges). Every other tab excludes pending.
  return {
    untriaged: active.filter((r) => !r.pending && cls(r) === "untriaged"),
    maintained: active.filter((r) => !r.pending && cls(r) === "maintained" && !covered(r)),
    pending: active.filter((r) => r.pending),
    covered: active.filter((r) => !r.pending && cls(r) === "maintained" && covered(r)),
    monitored: active.filter((r) => !r.pending && cls(r) === "monitored" && !notifiedCurrent(r)),
    notified: active.filter((r) => !r.pending && cls(r) === "monitored" && notifiedCurrent(r)),
    ignored: active.filter((r) => !r.pending && cls(r) === "ignored"),
    archived: repos.filter((r) => r.archived),
  };
}

function summaryOf(list) {
  const t = { critical: 0, high: 0, medium: 0, low: 0, total: 0, repos: list.length };
  for (const r of list) for (const k of SEVS.concat("total")) t[k] += r.counts[k] || 0;
  return t;
}

// ---- health -----------------------------------------------------------------
async function loadHealth() {
  try {
    const h = await getJSON("/api/health");
    $("#orgLabel").textContent = "· " + (h.org || "");
    const dot = $("#healthDot");
    if (h.ok) {
      dot.className = "dot ok";
      $("#healthText").innerHTML = `authed as <strong>${esc(h.login)}</strong>`;
    } else {
      dot.className = "dot bad";
      $("#healthText").textContent = "gh not authenticated — run `gh auth login`";
    }
  } catch {
    $("#healthDot").className = "dot bad";
    $("#healthText").textContent = "server unreachable";
  }
}

// ---- data -------------------------------------------------------------------
async function loadRepos(refresh) {
  // The Compliance tab owns its own content + loader, so don't cover it with the
  // alert-scan spinner when a refresh fires while we're sitting on it.
  if (STATE.tab !== "compliance") {
    $("#content").innerHTML = `<div class="loading"><span class="spin"></span>${
      refresh ? "Re-scanning GitHub…" : "Loading alerts from GitHub…"
    }</div>`;
  }
  try {
    const model = await getJSON("/api/repos" + (refresh ? "?refresh=1" : ""));
    if (model.error) throw new Error(model.error);
    STATE.model = model;
    render();
  } catch (e) {
    if (STATE.tab !== "compliance") $("#content").innerHTML = `<div class="banner">Failed to load alerts: ${esc(e.message)}</div>`;
  }
}

// ---- render -----------------------------------------------------------------
// Headline counts = IN-SCOPE work: maintained + pending (open-PR repos still count
// until merged). Only ignored/archived repos are excluded.
function renderSummary() {
  const p = partition();
  // "To maintain" = only what we actually patch: Maintained + Pending.
  const t = summaryOf([...p.maintained, ...p.pending]);

  $("#summary").innerHTML = `
    <div class="stat"><div class="n">${t.repos}</div><div class="l">to maintain</div></div>
    <div class="stat critical"><div class="n">${t.critical}</div><div class="l">critical</div></div>
    <div class="stat high"><div class="n">${t.high}</div><div class="l">high</div></div>
    <div class="stat medium"><div class="n">${t.medium}</div><div class="l">medium</div></div>
    <div class="stat low"><div class="n">${t.low}</div><div class="l">low</div></div>
    <div class="stat"><div class="n">${t.total}</div><div class="l">open alerts</div></div>`;
}

function renderTabs() {
  const p = partition();
  // Untriaged is the default catch-all bucket — hide its tab when empty (it
  // reappears the moment a repo lands there again). Every other tab always shows
  // so its count stays visible at a glance.
  const tabs = TABS.filter((t) => !HIDE_WHEN_EMPTY.has(t.key) || p[t.key].length > 0);
  // If the active tab is the one we just hid, fall back to the first visible tab.
  if (!tabs.some((t) => t.key === STATE.tab)) STATE.tab = tabs[0].key;
  // Compliance badge: while repos still need a scope decision, show that triage queue;
  // once it's empty, show the in-scope count (so it's never a misleading "0" when there's
  // a real inventory). Other tabs show their repo count.
  const cnt = (t) => {
    if (t.key === "compliance") {
      if (!STATE.complianceData) return "·";
      return STATE.complianceData.summary.inScope; // repos inside the SOC 2 boundary
    }
    // Ignored also includes ignored repos with no open alerts (pulled from the inventory).
    if (t.key === "ignored") return p.ignored.length + ignoredWithoutAlerts().length;
    return p[t.key].length;
  };
  // Tabs aren't visibly numbered, but respond to 1–5 / 0 (see jumpToTabByNumber + the ? help).
  $("#tabs").innerHTML = tabs
    .map(
      (t) =>
        `<button class="tab ${STATE.tab === t.key ? "active" : ""}" data-tab="${t.key}" title="${esc(TAB_INTROS[t.key] || t.label)}">
        ${t.label} <span class="tab-count">${cnt(t)}</span>
      </button>`
    )
    .join("");
  $("#tabs")
    .querySelectorAll(".tab")
    .forEach((b) =>
      b.addEventListener("click", () => {
        if (STATE.tab !== b.dataset.tab) { STATE.compCursor = 0; STATE.compSelected.clear(); STATE.alertSearch = ""; }
        STATE.tab = b.dataset.tab;
        render();
        if (STATE.tab === "pending") pollPRStatus(true); // freshen CI badges on entry
      })
    );
}

// h / l — move to the previous / next tab (vim style). Navigates the visible tab
// buttons in DOM order and clicks the target, reusing the normal tab-switch handler.
function moveTab(dir) {
  const tabs = [...document.querySelectorAll("#tabs .tab")];
  if (!tabs.length) return;
  const cur = tabs.findIndex((t) => t.classList.contains("active"));
  const idx = Math.max(0, Math.min((cur < 0 ? 0 : cur) + dir, tabs.length - 1));
  if (idx !== cur && tabs[idx]) tabs[idx].click();
}
// Number keys jump straight to a tab: 1..9 = Nth visible tab, 0 = Ignored (always last).
function jumpToTabByNumber(n) {
  const tabs = [...document.querySelectorAll("#tabs .tab")];
  if (!tabs.length) return;
  const target = n === 0 ? tabs.find((t) => t.dataset.tab === "ignored") || tabs[tabs.length - 1] : tabs[n - 1];
  if (target && !target.classList.contains("active")) target.click();
}
function tabNavKeydown(e) {
  if (document.querySelector(".modal-overlay")) return; // a modal owns the keyboard
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
  if (e.metaKey || e.altKey) return;
  // 1–9 → Nth visible tab, 0 → Ignored. (No Ctrl — that's the Compliance inner filter.)
  if (!e.ctrlKey && /^[0-9]$/.test(e.key)) { e.preventDefault(); jumpToTabByNumber(Number(e.key)); return; }
  const key = e.key.toLowerCase();
  if (key !== "h" && key !== "l") return;
  if (e.ctrlKey) {
    // Ctrl+h/l → previous/next inner filter (Compliance tab's segmented tabs).
    if (STATE.tab === "compliance") { e.preventDefault(); moveComplianceFilter(key === "l" ? 1 : -1); }
    return;
  }
  e.preventDefault();
  moveTab(key === "l" ? 1 : -1); // plain h/l → previous/next top-level tab
}
// Move between the Compliance inner filter tabs by clicking the rendered segments, so it
// always tracks whatever filters exist (incl. Archived) instead of a hardcoded order.
function moveComplianceFilter(dir) {
  const tabs = [...document.querySelectorAll(".comp-tab")];
  if (!tabs.length) return;
  const cur = tabs.findIndex((t) => t.classList.contains("active"));
  const idx = Math.max(0, Math.min((cur < 0 ? 0 : cur) + dir, tabs.length - 1));
  if (idx !== cur && tabs[idx]) tabs[idx].click(); // the click handler updates filter + redraws
}

function renderCards() {
  if (STATE.tab === "compliance") return renderCompliance();
  const content = $("#content");
  const q = (STATE.alertSearch || "").trim().toLowerCase();
  const full = partition()[STATE.tab];
  // The Ignored tab also surfaces ignored repos with NO open alerts — they never reach the
  // alert model, so we pull them from the full inventory and render them as compact rows.
  const extraIgnored = STATE.tab === "ignored"
    ? ignoredWithoutAlerts().filter((r) => !q || r.name.toLowerCase().includes(q))
    : [];
  if (!full.length && !extraIgnored.length) {
    const msg = {
      untriaged: "Nothing to triage — every repo is classified 🎉",
      maintained: "No actively-maintained repos with open alerts 🎉",
      pending: "No open update PRs. Create one from a Maintained repo and it'll land here awaiting merge.",
      covered: "No covered gems. A maintained gem whose constraints already permit every patch rests here.",
      monitored: "No monitored repos need a notice. Mark an inactive-client repo as “Monitor” to track it here.",
      notified: "No notifications sent yet. On a Monitored repo, copy the client email, then “Mark notified.”",
      ignored: "No ignored repos. Use “Ignore” on a repo that's out of scope for this tool.",
      archived: "No archived repos.",
    }[STATE.tab];
    content.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  const list = q ? full.filter((r) => (r.nameWithOwner || r.name).toLowerCase().includes(q)) : full;
  content.innerHTML = "";
  // Shared nav toolbar (hint + search + selection bar) — same as the Compliance tab.
  const bar = document.createElement("div");
  bar.className = "nav-toolbar";
  bar.innerHTML =
    `<div class="nav-toolbar-top">` +
    (tabIntro() ? `<div class="tab-intro">${tabIntro()}</div>` : `<div></div>`) +
    `<div class="comp-search-row"><input class="comp-search" type="text" placeholder="Search repositories…  (press /)" value="${esc(STATE.alertSearch || "")}">` +
    (q ? `<span class="muted">${list.length} match${list.length === 1 ? "" : "es"}</span>` : "") +
    `</div>` +
    `</div>` +
    `<div class="comp-selbar"${STATE.compSelected.size ? "" : " hidden"}>${STATE.compSelected.size ? selBarHtml() : ""}</div>`;
  content.appendChild(bar);
  // Branch protection only applies to maintained/pending — surface "protect all" there.
  if (STATE.tab === "maintained" || STATE.tab === "pending") {
    const unprotected = (STATE.model.repos || []).filter(
      (r) => !r.archived && (r.classification === "maintained" || r.pending) && STATE.protection[r.name] && STATE.protection[r.name].protected === false
    );
    if (unprotected.length) content.appendChild(protectAllBar(unprotected));
  }
  if (STATE.tab === "pending") content.appendChild(pendingToolbar(full));
  if (STATE.tab === "untriaged" || STATE.tab === "maintained") content.appendChild(fixAllToolbar(full));

  const ordered = nestedOrder(list);
  STATE.compRows = ordered.map((o) => o.repo);
  STATE.compCursor = Math.max(0, Math.min(STATE.compCursor, STATE.compRows.length - 1));
  const grid = document.createElement("div");
  grid.className = "grid";
  if (!ordered.length && !extraIgnored.length) {
    grid.innerHTML = `<div class="empty">No repos match “${esc(STATE.alertSearch)}”.</div>`;
  }
  ordered.forEach(({ repo, depth, parentName }, i) => {
    const c = card(repo, { depth, parentName });
    c.dataset.idx = i;
    if (i === STATE.compCursor) c.classList.add("cursor");
    if (STATE.compSelected.has(repo.name)) {
      c.classList.add("selected");
      const cb = c.querySelector(".nav-check");
      if (cb) cb.checked = true;
    }
    grid.appendChild(c);
  });
  // Compact rows for ignored repos with no open alerts (continue the cursor index past the cards).
  if (extraIgnored.length) {
    const base = STATE.compRows.length;
    extraIgnored.forEach((r, j) => {
      const c = ignoredLiteCard(r);
      const idx = base + j;
      c.dataset.idx = idx;
      if (idx === STATE.compCursor) c.classList.add("cursor");
      if (STATE.compSelected.has(r.name)) { c.classList.add("selected"); const cb = c.querySelector(".nav-check"); if (cb) cb.checked = true; }
      grid.appendChild(c);
    });
    STATE.compRows = STATE.compRows.concat(extraIgnored);
    STATE.compCursor = Math.max(0, Math.min(STATE.compCursor, STATE.compRows.length - 1));
  }
  content.appendChild(grid);

  // Wire nav: row checkbox toggles selection, clicking elsewhere on a row moves the cursor.
  grid.querySelectorAll(".alert-row").forEach((el) => {
    const cb = el.querySelector(".nav-check");
    if (cb) cb.addEventListener("click", (e) => { e.stopPropagation(); setCursor(Number(el.dataset.idx)); toggleSelectName(el.dataset.repo); });
    el.addEventListener("click", (e) => { if (!e.target.closest("a, button, input, summary, label")) setCursor(Number(el.dataset.idx)); });
  });
  grid.querySelectorAll(".row-unignore").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); onUnignore(e.currentTarget.closest("[data-repo]").dataset.repo); })
  );
  bar.querySelectorAll(".comp-selbar [data-kb]").forEach((b) => b.addEventListener("click", () => navAction(b.dataset.kb)));
  wireSearch(bar, (v) => { STATE.alertSearch = v; }, renderCards); // term is ephemeral (cleared on tab switch)
  reattachJobs(); // restore live logs for any in-flight update jobs
  scrollCursorIntoView();
}

// Ignored repos that have NO open alerts, so they never appear in the alert model — pulled
// from the full inventory (Compliance data) so the Ignored tab can show the complete set.
function ignoredWithoutAlerts() {
  const d = STATE.complianceData;
  if (!d || !d.repos) return [];
  const inModel = new Set(((STATE.model && STATE.model.repos) || []).map((r) => r.name));
  return d.repos.filter((r) => r.classification === "ignored" && !inModel.has(r.name));
}

// Compact card for an alert-free ignored repo (no alert data to show — just identity + undo).
function ignoredLiteCard(r) {
  const el = document.createElement("div");
  el.className = "card alert-row nav-row ignored lite-row";
  el.dataset.repo = r.name;
  const push = r.pushedAt ? relTime(r.pushedAt) : "—";
  el.innerHTML =
    `<input type="checkbox" class="nav-check" aria-label="select ${esc(r.name)}">` +
    `<div class="ar-body">` +
    `<div class="ar-l1">` +
    `<a class="ar-name" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` +
    `<span class="badge ignored-tag">ignored</span>` +
    `<span class="muted">· no open alerts</span>` +
    `</div>` +
    `<div class="ar-l2"><span class="ar-meta">${r.visibility ? esc(r.visibility.toLowerCase()) + " · " : ""}last push ${esc(push)}</span>` +
    `<span class="ar-actions"><button class="row-unignore">Un-ignore</button></span></div>` +
    `</div>`;
  return el;
}

// Un-ignore → clear the classification (back to untriaged); the repo then leaves this tab.
async function onUnignore(repo) {
  try {
    await postJSON("/api/classify", { repo, state: "" });
    STATE.compSelected.delete(repo);
    await loadComplianceData(); // refresh the inventory; renderTabs + (since on Ignored) re-render
    toast(`${repo} un-ignored → untriaged.`);
  } catch (e) {
    alert("Couldn't un-ignore: " + e.message);
  }
}

// ---- SOC 2 compliance inventory (the Compliance tab) ------------------------
// A full-org inventory (all 342 repos), separate from the alert-driven tabs. Each
// repo carries a recorded in/out-of-scope decision; branch protection is shown for
// the in-scope ones. Loaded lazily; protection badges fill in via a re-poll.
// Called from renderCards() when the Compliance tab is the active one. Draws cached
// data instantly; if there's none yet, shows a spinner *here* (we're on the tab) and
// kicks off the load. The load itself is tab-guarded, so a mid-load tab switch can't
// repaint another tab.
function renderCompliance() {
  if (STATE.complianceData) { drawCompliance(); return; }
  $("#content").innerHTML = `<div class="loading"><span class="spin"></span>Building the org-wide compliance inventory…</div>`;
  loadComplianceData();
}

// Fetch + cache the inventory WITHOUT assuming we're on the Compliance tab — safe to
// run in the background (e.g. pre-loaded on startup, or refreshed off-tab). Always
// updates the tab badge; only paints #content when the Compliance tab is active.
let _compLoading = false;
async function loadComplianceData(refresh) {
  if (_compLoading && !refresh) return;
  _compLoading = true;
  try {
    const data = await getJSON("/api/compliance" + (refresh ? "?refresh=1" : ""));
    if (data.error) throw new Error(data.error);
    STATE.complianceData = data;
    renderTabs(); // badge updates even if we're on another tab
    if (STATE.tab === "compliance") drawCompliance();
    else if (STATE.tab === "ignored") renderCards(); // alert-free ignored repos live in the inventory
    if (data.protectionPending || data.enrichPending) scheduleCompliancePoll();
  } catch (e) {
    if (STATE.tab === "compliance") $("#content").innerHTML = `<div class="banner">Failed to load the inventory: ${esc(e.message)}</div>`;
  } finally {
    _compLoading = false;
  }
}

let _compTimer = null;
function scheduleCompliancePoll() {
  if (_compTimer) return;
  _compTimer = setTimeout(async () => {
    _compTimer = null;
    try {
      const data = await getJSON("/api/compliance");
      STATE.complianceData = data;
      if (STATE.tab === "compliance") drawCompliance();
      if (data.protectionPending || data.enrichPending) scheduleCompliancePoll();
    } catch {
      /* retry on next interaction */
    }
  }, 3000);
}

function rankIn(map, val, dflt) {
  return Object.prototype.hasOwnProperty.call(map, val) ? map[val] : dflt;
}
// Sort key → comparable value for a compliance/archived row. Ranks order the enum columns
// most-engaged/in-scope/protected first; undecided / n-a fall to the end.
function compSortValue(r, key) {
  if (key === "name") return (r.name || "").toLowerCase();
  if (key === "push") return r.pushedAt ? Date.parse(r.pushedAt) || 0 : 0;
  if (key === "track") return rankIn(ENG_RANK, r.classification, ENGAGEMENTS.length); // untriaged/unknown sorts last
  if (key === "scope") return rankIn({ in: 0, out: 1 }, r.scope, 2);
  if (key === "prot") {
    if (!r.protectionScope) return 3; // not applicable ("—")
    if (r.protected === true) return 0;
    if (r.protected === false) return 1;
    return 2; // still checking
  }
  return 0;
}

function drawCompliance() {
  const content = $("#content");
  const d = STATE.complianceData;
  if (!d) return;
  const s = d.summary;
  const match = {
    in: (r) => r.scope === "in",
    out: (r) => r.scope === "out",
    overridden: (r) => !!r.scopeOverride,
    all: () => true,
  };
  // Coerce any stale stored filter (e.g. the old "undecided"/"needs") to a valid one.
  if (!match[STATE.complianceFilter] && STATE.complianceFilter !== "archived") STATE.complianceFilter = "all";
  const f = STATE.complianceFilter;
  const q = (STATE.compSearch || "").trim().toLowerCase();
  const onArchived = f === "archived";
  const source = onArchived ? d.archived || [] : d.repos.filter(match[f] || match.all);
  const rows = source.filter((r) => !q || r.name.toLowerCase().includes(q));
  if (STATE.compSort.key) {
    const k = STATE.compSort.key, dir = STATE.compSort.dir;
    rows.sort((a, b) => {
      const va = compSortValue(a, k), vb = compSortValue(b, k);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return (a.name || "").localeCompare(b.name || ""); // stable tiebreak by name
    });
  }
  STATE.compRows = rows;
  STATE.compCursor = Math.max(0, Math.min(STATE.compCursor, rows.length - 1));
  const filters = [
    ["in", "In scope", s.inScope],
    ["out", "Out of scope", s.outScope],
    ["overridden", "Overridden", s.overridden],
    ["all", "All", s.total],
    ["archived", "Archived", (d.archived || []).length],
  ];

  // Sortable column headers: click to sort, click again to flip direction.
  const arrow = (key) => (STATE.compSort.key === key ? ` <span class="sort-arrow">${STATE.compSort.dir === 1 ? "▲" : "▼"}</span>` : "");
  const sth = (key, label, info) => `<th class="sortable${STATE.compSort.key === key ? " sorted" : ""}" data-sort="${key}">${label}${info || ""}${arrow(key)}</th>`;
  const trackInfo = ` <span class="info-icon" tabindex="0" data-tip="How you engage with this repo. “Maintain” = we open update PRs and enforce branch protection. “Monitor” = we email the client but don't patch (their repo). “Ignore” = no action. Same classification as the alert tabs.">i</span>`;
  const protInfo = ` <span class="info-icon" tabindex="0" data-tip="Tracked and enforced only on repos you Maintain — a SOC 2 ruleset requiring PR review on the default branch. Monitored, notified, and ignored repos show “—” since you don't control them.">i</span>`;
  const scopeInfo = ` <span class="info-icon" tabindex="0" data-tip="Inside your SOC 2 audit boundary? DERIVED from engagement: Maintain (or an open PR) = In scope; Monitor / Ignore / untriaged = Out. Use the ⚙ to override the rare exception (e.g. an internal gem you maintain but exclude), with a logged reason.">i</span>`;
  const thead =
    `<thead><tr><th class="comp-check-col"><input type="checkbox" class="comp-check-all" title="Select all in view (*)"></th>` +
    sth("name", "Repository") +
    sth("push", "Last push") +
    sth("track", "Track as", trackInfo) +
    sth("prot", "Branch protection", protInfo) +
    sth("scope", "SOC 2 scope", scopeInfo) +
    `<th>${onArchived ? "Restore" : "Prune"}</th></tr></thead>`;

  content.innerHTML =
    // Row 1: segmented filter tabs + search (the tabs carry the per-bucket counts).
    `<div class="comp-toolbar-row">` +
    `<div class="comp-tabs" role="tablist">` +
    filters.map(([key, name, n]) => `<button class="comp-tab ${f === key ? "active" : ""}${key === "archived" ? " archived-tab" : ""}" role="tab" data-filter="${key}">${esc(name)} <span class="ct">${n}</span></button>`).join("") +
    `</div>` +
    `<input class="comp-search" type="text" placeholder="Search repositories…  (press /)" value="${esc(STATE.compSearch)}">` +
    (q ? `<span class="muted comp-match">${rows.length} match${rows.length === 1 ? "" : "es"}</span>` : "") +
    `</div>` +
    // Row 2: bulk actions — not shown on the Archived view (nothing to triage/protect there).
    (onArchived
      ? `<div class="comp-note">${(d.archived || []).length} archived repos — read-only, excluded from the active inventory and all dependency/compliance scans. Unarchive to bring one back, or delete to prune it.</div>`
      : `<div class="comp-actions-row">` +
        (s.unprotected ? `<button class="comp-bulk-btn protect-all" data-protect="1">🛡 Protect ${s.unprotected} unprotected</button>` : "") +
        `</div>`) +
    `<div class="comp-selbar"${STATE.compSelected.size ? "" : " hidden"}>${STATE.compSelected.size ? selBarHtml() : ""}</div>` +
    `<table class="comp-table">${thead}<tbody>` +
    rows.map((r, i) => (onArchived ? archivedRow(r, i) : complianceRow(r, i))).join("") +
    `</tbody></table>` +
    (rows.length === 0 ? `<div class="empty">${onArchived ? "No archived repos." : "No repos in this view 🎉"}</div>` : "");

  content.querySelectorAll(".comp-tab").forEach((b) =>
    b.addEventListener("click", () => {
      STATE.complianceFilter = b.dataset.filter;
      lsSet("compliance.filter", STATE.complianceFilter);
      STATE.compCursor = 0;
      STATE.compSelected.clear();
      drawCompliance();
    })
  );
  content.querySelectorAll(".comp-table th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (STATE.compSort.key === key) STATE.compSort.dir = -STATE.compSort.dir; // flip
      else { STATE.compSort.key = key; STATE.compSort.dir = 1; } // new column → ascending
      lsSet("compliance.sortKey", STATE.compSort.key);
      lsSet("compliance.sortDir", String(STATE.compSort.dir));
      STATE.compCursor = 0;
      drawCompliance();
    })
  );
  const pAll = content.querySelector(".comp-bulk-btn[data-protect]");
  if (pAll) pAll.addEventListener("click", () => onComplianceProtectAll(pAll));
  content.querySelectorAll(".comp-row").forEach((tr) => {
    const se = tr.querySelector(".scope-edit");
    if (se) se.addEventListener("click", (e) => { e.stopPropagation(); onScopeOverride(se.dataset.repo); });
    const pb = tr.querySelector(".row-protect");
    if (pb) pb.addEventListener("click", () => onRowProtect(tr.dataset.repo, pb));
    const ar = tr.querySelector(".row-archive");
    if (ar) ar.addEventListener("click", () => onComplianceArchive(tr.dataset.repo));
    const un = tr.querySelector(".row-unarchive");
    if (un) un.addEventListener("click", () => onComplianceUnarchive(tr.dataset.repo));
    const ts = tr.querySelector(".track-select");
    if (ts) ts.addEventListener("change", () => onComplianceClassify(tr.dataset.repo, ts.value));
    const eb = tr.querySelector(".eng-badge");
    if (eb) eb.addEventListener("click", (e) => { e.stopPropagation(); showEngagementHistory(eb.dataset.eng); });
    const dl = tr.querySelector(".row-delete");
    if (dl) dl.addEventListener("click", () => genericDelete(tr.dataset.repo));
    const cb = tr.querySelector(".nav-check");
    if (cb) cb.addEventListener("click", (e) => { e.stopPropagation(); setCursor(Number(tr.dataset.idx)); toggleSelectName(tr.dataset.repo); });
    // clicking anywhere else on the row just moves the cursor there
    tr.addEventListener("click", (e) => { if (!e.target.closest("a, button, input")) setCursor(Number(tr.dataset.idx)); });
  });
  content.querySelectorAll(".comp-selbar [data-kb]").forEach((b) => b.addEventListener("click", () => navAction(b.dataset.kb)));
  const checkAll = content.querySelector(".comp-check-all");
  if (checkAll) checkAll.addEventListener("click", () => selectAllToggle());
  syncSelectAll();
  wireSearch(content, (v) => { STATE.compSearch = v; lsSet("compliance.search", v); }, drawCompliance);
  scrollCursorIntoView();
}

// ---- Compliance keyboard navigation + multi-select (gmail/vim style) --------
function cursorRepo() {
  return (STATE.compRows || [])[STATE.compCursor] || null;
}
// Mark rows as "working" (spinner + dim) while an async action runs. A re-render clears it
// automatically; clearRowBusy() handles error paths that don't re-render.
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, "\\$&");
}
function setRowsBusy(names) {
  (names || []).forEach((n) => {
    const row = compRowEl(n);
    if (row) row.classList.add("busy");
  });
}
function clearRowBusy() {
  document.querySelectorAll(".nav-row.busy").forEach((el) => el.classList.remove("busy"));
}
// Disable a button and show a busy label; returns a restore fn for failure paths.
// Captures the rendered label so restores can't drift from what render() drew.
function btnBusy(btn, busyHtml) {
  if (!btn) return () => {};
  const prev = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = busyHtml;
  return () => { btn.disabled = false; btn.textContent = prev; };
}
function selectedOrCursor() {
  if (STATE.compSelected.size) return (STATE.compRows || []).filter((r) => STATE.compSelected.has(r.name)).map((r) => r.name);
  const r = cursorRepo();
  return r ? [r.name] : [];
}
function compRowEl(name) {
  return document.querySelector(`.nav-row[data-repo="${cssEscape(name)}"]`);
}
function setCursor(idx) {
  const n = (STATE.compRows || []).length;
  if (!n) return;
  STATE.compCursor = Math.max(0, Math.min(idx, n - 1));
  document.querySelectorAll(".nav-row.cursor").forEach((el) => el.classList.remove("cursor"));
  const cur = document.querySelector(`.nav-row[data-idx="${STATE.compCursor}"]`);
  if (!cur) return;
  cur.classList.add("cursor");
  // At the first row, reveal the whole page top (summary, filters, search) rather than
  // tucking row 0 under the sticky header — so `gg` and `k`-to-the-top scroll the page up.
  if (STATE.compCursor === 0) window.scrollTo({ top: 0, behavior: "smooth" });
  else scrollRowClearOfHeader(cur);
}
// scrollIntoView doesn't know about the sticky <header>, so a row scrolled to the
// viewport top hides behind it. Scroll manually, leaving room below the header.
function scrollRowClearOfHeader(el) {
  const header = document.querySelector("header");
  const topEdge = header ? header.getBoundingClientRect().bottom : 0;
  const r = el.getBoundingClientRect();
  const margin = 8;
  if (r.top < topEdge + margin) window.scrollBy({ top: r.top - topEdge - margin });
  else if (r.bottom > window.innerHeight - margin) window.scrollBy({ top: r.bottom - window.innerHeight + margin });
}
function scrollCursorIntoView() {
  const cur = document.querySelector(`.nav-row[data-idx="${STATE.compCursor}"]`);
  if (cur) scrollRowClearOfHeader(cur);
}
function toggleSelectName(name) {
  if (STATE.compSelected.has(name)) STATE.compSelected.delete(name);
  else STATE.compSelected.add(name);
  const row = compRowEl(name);
  if (row) {
    const on = STATE.compSelected.has(name);
    row.classList.toggle("selected", on);
    const cb = row.querySelector(".nav-check");
    if (cb) cb.checked = on;
  }
  updateSelBar();
}
function clearSelection() {
  STATE.compSelected.clear();
  document.querySelectorAll(".nav-row.selected").forEach((el) => {
    el.classList.remove("selected");
    const cb = el.querySelector(".nav-check");
    if (cb) cb.checked = false;
  });
  updateSelBar();
}
function selBarHtml() {
  const n = STATE.compSelected.size;
  const btns =
    STATE.tab === "compliance"
      ? `<button class="selbar-btn" data-kb="e">Archive <kbd>e</kbd></button> ` +
        `<button class="selbar-btn" data-kb="s">Out of scope <kbd>s</kbd></button> ` +
        `<button class="selbar-btn" data-kb="n">Needs compliance <kbd>n</kbd></button> `
      : `<button class="selbar-btn" data-kb="e">Archive <kbd>e</kbd></button> ` +
        `<button class="selbar-btn" data-kb="y">Copy links <kbd>y</kbd></button> `;
  return `<strong>${n}</strong> selected · ${btns}<button class="selbar-btn subtle" data-kb="clear">Clear <kbd>Esc</kbd></button>`;
}
function updateSelBar() {
  syncSelectAll();
  const sb = document.querySelector(".comp-selbar");
  if (!sb) return;
  if (!STATE.compSelected.size) { sb.hidden = true; sb.innerHTML = ""; return; }
  sb.hidden = false;
  sb.innerHTML = selBarHtml();
  sb.querySelectorAll("[data-kb]").forEach((b) => b.addEventListener("click", () => navAction(b.dataset.kb)));
}
// Keep the header "select all" box in sync: checked when all rows are selected,
// indeterminate (dash) when only some are.
function syncSelectAll() {
  const cb = document.querySelector(".comp-check-all");
  if (!cb) return;
  const rows = STATE.compRows || [];
  const n = rows.filter((r) => STATE.compSelected.has(r.name)).length;
  cb.checked = rows.length > 0 && n === rows.length;
  cb.indeterminate = n > 0 && n < rows.length;
}
// Dispatch a keyboard/sel-bar action for the CURRENT tab. Compliance and the alert
// tabs share movement/selection/search/copy; the per-tab action keys differ.
function navAction(key) {
  if (key === "clear") return clearSelection();
  if (key === "y") return kbCopyLinks();
  if (key === "o") return kbOpen();
  if (STATE.tab === "compliance") {
    if (key === "e") return kbArchive();
    if (key === "#") return kbDelete();
    if (key === "r") return kbEmail();
    if (key === "p") return kbProtectCompliance();
    if (key === "m") return kbTrack("maintained");
    if (key === "w") return kbTrack("monitored");
    if (key === "i") return kbTrack("ignored");
    return;
  }
  if (key === "e") return kbArchiveAlert();
  if (key === "#") return kbDelete();
  if (key === "r") return kbEmail();
  if (key === "u") return kbUpdate();
  if (key === "U") return kbUpgrade();
  if (key === "p") return kbProtect();
  if (key === "f") return kbFixCI();
}
// Repos a bulk action targets: the selection if any, else the cursor row.
function navTargetRepos(bulk) {
  const rows = STATE.compRows || [];
  if (bulk && STATE.compSelected.size) return rows.filter((r) => STATE.compSelected.has(r.name));
  const r = cursorRepo();
  return r ? [r] : [];
}
async function kbArchive() {
  const names = selectedOrCursor();
  if (!names.length) return;
  const msg =
    names.length === 1
      ? `Archive ${names[0]} on GitHub?\n\nIt becomes read-only and drops out of the inventory. Reversible from repo settings.`
      : `Archive ${names.length} selected repos on GitHub?\n\n${names.slice(0, 10).map((n) => "• " + n).join("\n")}${names.length > 10 ? "\n• …" : ""}\n\nEach becomes read-only and drops out of the inventory. Reversible.`;
  if (!(await confirmModal({ message: msg, confirmLabel: "Archive", rememberKey: "archive" }))) return;
  setRowsBusy(names);
  for (const name of names) {
    try {
      await postJSON("/api/archive", { repo: name });
      STATE.complianceData.repos = STATE.complianceData.repos.filter((r) => r.name !== name);
      STATE.compSelected.delete(name);
    } catch {
      /* keep going */
    }
  }
  recomputeComplianceSummary();
  drawCompliance();
  renderTabs();
}
function kbDelete() {
  // Delete is single-only (never bulk) — always acts on the row under the cursor.
  const r = cursorRepo();
  if (r) genericDelete(r.name);
}
// Typed-confirm delete that works from any tab: drops the repo from whichever
// in-memory list(s) hold it (alert model and/or compliance inventory) and re-renders.
async function genericDelete(repo) {
  const ok = await confirmModal({
    message: `⚠️ PERMANENTLY DELETE "${repo}" on GitHub?\n\nThis is irreversible — the repo, its issues, PRs, and history are gone.`,
    danger: true,
    confirmLabel: "Delete this repository",
    requireMatch: repo,
  });
  if (!ok) return;
  setRowsBusy([repo]);
  try {
    await postJSON("/api/delete-repo", { repo, confirm: repo });
    if (STATE.complianceData) {
      STATE.complianceData.repos = STATE.complianceData.repos.filter((x) => x.name !== repo);
      if (STATE.complianceData.archived) STATE.complianceData.archived = STATE.complianceData.archived.filter((x) => x.name !== repo);
    }
    if (STATE.model) STATE.model.repos = STATE.model.repos.filter((x) => x.name !== repo);
    STATE.compSelected.delete(repo);
    if (STATE.tab === "compliance") { recomputeComplianceSummary(); drawCompliance(); renderTabs(); }
    else render();
  } catch (e) {
    clearRowBusy();
    // 412 = the token lacks delete permission; the server's message says how to fix it.
    if (e.status === 412 && e.data && e.data.needsScope) { alert(e.message); return; }
    alert("Couldn't delete: " + e.message);
  }
}
// Archive the selected (or cursor) repos on the alert tabs: flags them archived in the
// model so they drop off the active tab, then re-renders.
async function kbArchiveAlert() {
  const repos = navTargetRepos(true);
  if (!repos.length) return;
  const names = repos.map((r) => r.nameWithOwner || r.name);
  const msg = names.length === 1
    ? `Archive ${names[0]} on GitHub?\n\nIt becomes read-only and drops out of the audit. Reversible from repo settings.`
    : `Archive ${names.length} selected repos on GitHub?\n\n${names.slice(0, 10).map((n) => "• " + n).join("\n")}${names.length > 10 ? "\n• …" : ""}\n\nEach becomes read-only and drops out of the audit. Reversible.`;
  if (!(await confirmModal({ message: msg, confirmLabel: "Archive", rememberKey: "archive" }))) return;
  setRowsBusy(repos.map((r) => r.name));
  for (const r of repos) {
    try {
      await postJSON("/api/archive", { repo: r.name });
      if (STATE.model) { const m = STATE.model.repos.find((x) => x.name === r.name); if (m) m.archived = true; STATE.compSelected.delete(r.name); }
    } catch {
      /* keep going */
    }
  }
  render();
}
function kbUpdate() { const r = cursorRepo(); if (r) onUpdate(r, compRowEl(r.name)); }
function kbProtect() { const r = cursorRepo(); if (r) onProtectBranch(r, compRowEl(r.name)); }
function kbFixCI() { const r = cursorRepo(); if (r) onFixCI(r); }
function kbUpgrade() {
  const r = cursorRepo();
  if (!r) return;
  const findings = STATE.eol[r.name];
  if (!findings || !findings.length) { toast(`No end-of-life runtime to upgrade on ${r.name}.`); return; }
  onUpgradeRuntime(r, findings[0].id); // first EOL finding (almost always the only one)
}
function kbEmail() {
  const r = cursorRepo();
  if (!r) return;
  // On alert tabs the cursor repo is already the full alert repo; on compliance, look it up.
  const ar = r.classification ? r : STATE.model && STATE.model.repos.find((x) => x.name === r.name);
  if (!ar || !(ar.classification === "monitored" || ar.classification === "maintained")) {
    toast(`No client email for ${r.name} — only monitored/maintained client repos have a contact.`);
    return;
  }
  onEmail(ar, compRowEl(r.name));
  toast(`Building client email for ${r.name}…`);
}
// Set engagement (Track as) on the cursor row (or all selected) from the keyboard, then
// refresh so the derived protection scope/status catches up with the new classification.
async function kbTrack(toState) {
  const names = selectedOrCursor();
  if (!names.length) return;
  const clsOf = (n) => { const r = STATE.complianceData.repos.find((x) => x.name === n); return (r && r.classification) || "untriaged"; };
  const changing = names.filter((n) => clsOf(n) !== toState);
  if (!changing.length) { toast(`Already ${engagementLabel(toState)}.`); return; }
  const meta = await engagementNoteModal({
    subject: changing.length === 1 ? changing[0] : `${changing.length} repos`,
    from: changing.length === 1 ? clsOf(changing[0]) : null,
    to: toState,
  });
  if (!meta) return;
  setRowsBusy(changing);
  for (const name of changing) {
    try {
      await postJSON("/api/classify", { repo: name, state: toState, note: meta.note, sowEndDate: meta.sowEndDate });
    } catch {
      /* keep going */
    }
  }
  STATE.compSelected.clear();
  await loadComplianceData();
  toast(`Tracked ${changing.length} repo${changing.length > 1 ? "s" : ""} as ${engagementLabel(toState)}.`);
}
// `p` on the Compliance tab — apply the SOC 2 ruleset to the cursor row (only meaningful
// for a maintained repo whose default branch is currently unprotected).
function kbProtectCompliance() {
  const r = cursorRepo();
  if (!r) return;
  if (!r.protectionScope) { toast(`Branch protection is only tracked for maintained repos — ${r.name} isn't one.`); return; }
  if (r.protected === true) { toast(`${r.name}'s default branch is already protected.`); return; }
  if (r.protected !== false) { toast(`Protection status for ${r.name} is still loading…`); return; }
  onRowProtect(r.name);
}
function kbOpen() {
  const r = cursorRepo();
  if (!r) return;
  // Prefer the open PR if there is one (the Pending tab's actionable target); else the repo.
  const pr = r.openPRs && r.openPRs[0];
  const url = (pr && pr.url) || r.url;
  if (url) window.open(url, "_blank", "noopener");
}
// `d` — list the cursor repo's dependencies (internal graph + flagged packages) in a modal.
function kbDependencies() {
  const r = cursorRepo();
  if (!r) return;
  const dependsOn = r.dependsOnOrg || [];
  const dependents = r.dependents || [];
  const pkgs = r.packages || [];
  if (!dependsOn.length && !dependents.length && !pkgs.length) {
    toast(`No dependency data for ${r.name}.`);
    return;
  }
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const rank = (s) => (sevRank[s] == null ? 9 : sevRank[s]);
  const sorted = pkgs.slice().sort((a, b) => rank(a.severity) - rank(b.severity) || String(a.pkg).localeCompare(String(b.pkg)));
  const pkgRows = sorted
    .map(
      (p) =>
        `<div class="dep-modal-row">` +
        `<span class="badge ${esc(p.severity || "")}">${esc(p.severity || "—")}</span>` +
        `<a class="dep-modal-pkg" href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(p.pkg)}</a>` +
        `<span class="muted">${esc(p.ecosystem || "")}${p.patched ? ` · → ${esc(p.patched)}` : ""}${p.manifest ? ` · ${esc(p.manifest)}` : ""}</span>` +
        `</div>`
    )
    .join("");
  const chips = (arr) => `<div class="dep-modal-chips">${arr.map((n) => `<span class="dep-tag">${esc(n)}</span>`).join(" ")}</div>`;
  const sec = (label, body) => (body ? `<div class="dep-modal-sec">${label}</div>${body}` : "");
  const html =
    `<div class="dep-modal">` +
    sec(`Depends on org repos (${dependsOn.length})`, dependsOn.length ? chips(dependsOn) : "") +
    sec(`Depended on by org repos (${dependents.length})`, dependents.length ? chips(dependents) : "") +
    sec(`Flagged dependency packages (${pkgs.length})`, pkgRows ? `<div class="dep-modal-pkgs">${pkgRows}</div>` : "") +
    `</div>`;
  confirmModal({ title: `Dependencies — ${r.nameWithOwner || r.name}`, html, confirmLabel: "Close", cancelLabel: null });
}
function engagementLabel(s) {
  return ENG_LABEL[s] || "Untriaged"; // "Untriaged" fallback is used for from-states in audit badges
}
function engDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return iso || ""; }
}

// Required-note modal shown on EVERY engagement (Track-as) change — the SOC 2 audit
// prompt. Resolves { note, sowEndDate } or null if cancelled. Note required, SOW optional.
function engagementNoteModal({ subject, from, to }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-overlay";
    const trans = (from == null ? "" : engagementLabel(from) + " → ") + `<strong>${engagementLabel(to)}</strong>`;
    overlay.innerHTML =
      `<div class="modal confirm" role="dialog" aria-modal="true">` +
      `<div class="modal-title">Engagement change</div>` +
      `<div class="modal-body"><div class="eng-modal">` +
      `<div class="eng-trans">${esc(subject)} · ${trans}</div>` +
      `<p class="eng-hint">Record why this changed — your SOC 2 audit trail of when responsibility shifted.</p>` +
      `<label class="eng-field"><span>Note <em class="req">required</em></span>` +
      `<textarea class="eng-note" rows="3" placeholder="e.g. SOW ended; client to self-manage. Notified of open vulnerabilities."></textarea></label>` +
      `<label class="eng-field"><span>SOW end date <em class="opt">optional</em></span>` +
      `<input type="date" class="eng-sow"></label>` +
      `<p class="eng-tip muted">⌘/Ctrl + Enter to save · Esc to cancel</p>` +
      `</div></div>` +
      `<div class="modal-actions">` +
      `<button class="modal-cancel subtle">Cancel</button>` +
      `<button class="modal-confirm primary" disabled>Save &amp; apply</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);
    const note = overlay.querySelector(".eng-note");
    const sow = overlay.querySelector(".eng-sow");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const close = (val) => { document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve(val); };
    const commit = () => { const n = note.value.trim(); if (!n) return; close({ note: n, sowEndDate: sow.value || null }); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); commit(); }
    };
    document.addEventListener("keydown", onKey, true);
    note.addEventListener("input", () => { confirmBtn.disabled = !note.value.trim(); });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    cancelBtn.addEventListener("click", () => close(null));
    confirmBtn.addEventListener("click", commit);
    setTimeout(() => note.focus(), 30);
  });
}

// Read-only timeline of a repo's engagement changes (newest first).
async function showEngagementHistory(repo) {
  let log = [];
  try { log = (await getJSON("/api/engagement-log?repo=" + encodeURIComponent(repo))).log || []; } catch { /* show empty */ }
  // Entries are either engagement (Track-as) changes or scope-override changes.
  const lbl = (e, v) => (e.kind === "scope" ? (v === "in" ? "In scope" : "Out of scope") : engagementLabel(v));
  const rows = log
    .slice()
    .reverse()
    .map(
      (e) =>
        `<div class="eng-hist-row">` +
        `<div class="eng-hist-head"><span><span class="hist-kind${e.kind === "scope" ? " scope" : ""}">${e.kind === "scope" ? "scope" : "engagement"}</span> ${lbl(e, e.from)} → <strong>${lbl(e, e.to)}</strong></span><span class="muted">${esc(engDate(e.at))}</span></div>` +
        (e.sowEndDate ? `<div class="eng-hist-sow">SOW end: ${esc(e.sowEndDate)}</div>` : "") +
        `<div class="eng-hist-note${e.note ? "" : " muted"}">${e.note ? esc(e.note) : "(no note)"}</div>` +
        `</div>`
    )
    .join("");
  confirmModal({
    title: `Engagement history — ${repo}`,
    html: `<div class="eng-hist">${rows || '<p class="muted">No recorded engagement changes yet.</p>'}</div>`,
    confirmLabel: "Close",
    cancelLabel: null,
  });
}
// Override a repo's DERIVED scope (the rare exception). Resolves { scope, reason } where
// scope is "in"/"out" to force, or null to clear back to the engagement-derived default.
// Cancelled → resolves null. A reason is required when forcing a value ≠ the derived one.
function scopeOverrideModal({ repo, derived, current }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-overlay";
    const derivedL = derived === "in" ? "In scope" : "Out of scope";
    const curVal = current ? current.scope : "";
    const opt = (val, label, desc) =>
      `<label class="scope-opt"><input type="radio" name="scopeopt" value="${val}"${(curVal || "") === val ? " checked" : ""}>` +
      `<span><strong>${label}</strong><em>${desc}</em></span></label>`;
    overlay.innerHTML =
      `<div class="modal confirm" role="dialog" aria-modal="true">` +
      `<div class="modal-title">SOC 2 scope — ${esc(repo)}</div>` +
      `<div class="modal-body"><div class="eng-modal">` +
      `<div class="scope-opts">` +
      opt("", "Auto", `Follow engagement → ${derivedL}`) +
      opt("in", "Force In scope", "Subject to the controls regardless of engagement") +
      opt("out", "Force Out of scope", "Excluded from the audit boundary — e.g. an internal/OSS tool") +
      `</div>` +
      `<label class="eng-field"><span>Reason <em class="req">required for an override</em></span>` +
      `<textarea class="scope-reason" rows="2" placeholder="e.g. Internal gem — not part of the customer-facing system boundary.">${esc((current && current.reason) || "")}</textarea></label>` +
      `</div></div>` +
      `<div class="modal-actions"><button class="modal-cancel subtle">Cancel</button><button class="modal-confirm primary">Save</button></div>` +
      `</div>`;
    document.body.appendChild(overlay);
    const reason = overlay.querySelector(".scope-reason");
    const confirmBtn = overlay.querySelector(".modal-confirm");
    const cancelBtn = overlay.querySelector(".modal-cancel");
    const selected = () => (overlay.querySelector('input[name="scopeopt"]:checked') || {}).value || "";
    const isOverride = () => { const v = selected(); return v !== "" && v !== derived; };
    const gate = () => { confirmBtn.disabled = isOverride() && !reason.value.trim(); };
    const close = (val) => { document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve(val); };
    const commit = () => {
      const v = selected();
      if (isOverride() && !reason.value.trim()) return;
      close({ scope: v === "" || v === derived ? null : v, reason: reason.value.trim() || null });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); commit(); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.querySelectorAll('input[name="scopeopt"]').forEach((i) => i.addEventListener("change", gate));
    reason.addEventListener("input", gate);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    cancelBtn.addEventListener("click", () => close(null));
    confirmBtn.addEventListener("click", commit);
    gate();
    setTimeout(() => reason.focus(), 30);
  });
}

async function onScopeOverride(repo) {
  const r = STATE.complianceData.repos.find((x) => x.name === repo);
  if (!r) return;
  const meta = await scopeOverrideModal({ repo, derived: r.scopeDerived, current: r.scopeOverride });
  if (meta === null) return;
  setRowsBusy([repo]);
  try {
    const data = await postJSON("/api/scope-override", { repo, scope: meta.scope, reason: meta.reason });
    toast(`${repo}: ${data.scope === "in" ? "In scope" : "Out of scope"}${data.override ? " (override)" : " (auto)"}.`);
    loadComplianceData();
  } catch (e) {
    clearRowBusy();
    alert("Couldn't set scope: " + e.message);
  }
}
function showShortcutHelp() {
  const k = (...keys) => keys.map((s) => `<kbd>${esc(s)}</kbd>`).join("");
  const row = (keys, desc) => `<div class="kbd-keys">${keys}</div><div class="kbd-desc">${desc}</div>`;
  const onCompliance = STATE.tab === "compliance";
  const sections = [
    ["Navigate", [
      [k("h") + "/" + k("l"), "previous / next tab"],
      [k("1") + "–" + k("5") + " / " + k("0"), "jump to a tab (0 = Ignored)"],
      [onCompliance ? `${k("⌃", "h")}/${k("⌃", "l")}` : "", onCompliance ? "previous / next filter" : ""],
      [k("j") + "/" + k("k") + " " + k("↑") + "/" + k("↓"), "move between rows"],
      [k("g") + k("g") + " / " + k("G"), "jump to top / bottom"],
      [k("o") + " / " + k("⏎"), "open the PR (or repo) on GitHub"],
      [k("d"), "show this repo's dependencies"],
    ]],
    ["Select", [
      [k("x"), "select / deselect a row"],
      [k("*"), "select / deselect all in view"],
      [k("Esc"), "clear selection"],
      [k("/"), "search by name"],
      [k("y"), "copy repo link(s)"],
    ]],
    ["Actions", onCompliance ? [
      [k("e"), "archive (selected, or cursor row)"],
      [k("#"), "delete (cursor row, typed confirm)"],
      [k("r"), "email the client"],
      [k("p"), "protect the branch (maintained repos)"],
      [k("m") + " / " + k("w") + " / " + k("i"), "Track as Maintain / Monitor / Ignore"],
    ] : [
      [k("u"), "open an update PR"],
      [k("U"), "propose a runtime upgrade (EOL)"],
      [k("p"), "protect the branch"],
      [k("f"), "fix failing CI"],
      [k("r"), "email the client"],
      [k("e") + " / " + k("#"), "archive / delete"],
    ]],
  ];
  const html =
    `<div class="kbd-help">` +
    sections
      .map(([name, rows]) =>
        `<div class="kbd-sec">${name}</div>` +
        `<div class="kbd-grid">${rows.filter(([keys]) => keys).map(([keys, desc]) => row(keys, desc)).join("")}</div>`
      )
      .join("") +
    `</div>`;
  confirmModal({
    title: `Keyboard shortcuts — ${onCompliance ? "Compliance" : "this tab"}`,
    html,
    confirmLabel: "Got it",
    cancelLabel: "Close",
  });
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, 2600);
}
// Per-tab action keys (movement/select/search/copy are shared; these differ by tab).
function tabActionKeys() {
  return STATE.tab === "compliance" ? "e#rpmwi" : "e#rupfU";
}
// Two-stage search Esc: the input's first Esc blurs + arms this window; a second Esc
// shortly after clears the kept term. Placed before the compRows guard so it still works
// when the search matched nothing (0 rows).
function armSearchEsc() {
  STATE._searchBlurAt = Date.now();
}
// Wire a tab's .comp-search input. setTerm stores the term (and persists it if the tab
// wants that); redraw repaints the tab. Coordinates with navKeydown's two-stage Esc.
function wireSearch(root, setTerm, redraw) {
  const search = root.querySelector(".comp-search");
  if (!search) return;
  search.addEventListener("input", () => { setTerm(search.value); STATE.compCursor = 0; STATE._refocusSearch = true; redraw(); });
  search.addEventListener("keydown", (ev) => {
    // First Esc just blurs back to the list (keeps the term + filter); a second Esc
    // within 800ms clears the term (handled globally in navKeydown). stopPropagation so
    // THIS keypress doesn't also reach the global handler after the synchronous blur.
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); STATE._refocusSearch = false; search.blur(); armSearchEsc(); }
    else if (ev.key === "Enter") { ev.preventDefault(); search.blur(); } // back to nav, cursor on first match
  });
  if (STATE._refocusSearch) {
    STATE._refocusSearch = false;
    search.focus();
    const v = search.value; // bounce to put the caret at the end
    search.value = "";
    search.value = v;
  }
}
function currentSearchTerm() {
  return (STATE.tab === "compliance" ? STATE.compSearch : STATE.alertSearch) || "";
}
function clearCurrentSearch() {
  STATE.compCursor = 0;
  if (STATE.tab === "compliance") { STATE.compSearch = ""; lsSet("compliance.search", ""); drawCompliance(); }
  else { STATE.alertSearch = ""; renderCards(); }
}

function navKeydown(e) {
  if (document.querySelector(".modal-overlay")) return; // a modal owns the keyboard
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Second Esc within 800ms of blurring the search clears the kept term (then stops here).
  if (e.key === "Escape" && STATE._searchBlurAt && Date.now() - STATE._searchBlurAt < 800) {
    STATE._searchBlurAt = 0;
    if (currentSearchTerm()) { e.preventDefault(); clearCurrentSearch(); return; }
  }
  if (!(STATE.compRows || []).length) return; // nothing navigable on this tab
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); setCursor(STATE.compCursor + 1); break;
    case "k": case "ArrowUp": e.preventDefault(); setCursor(STATE.compCursor - 1); break;
    case "x": { e.preventDefault(); const r = cursorRepo(); if (r) toggleSelectName(r.name); break; }
    case "o": case "Enter": e.preventDefault(); navAction("o"); break;
    case "y": e.preventDefault(); navAction("y"); break;
    case "d": e.preventDefault(); kbDependencies(); break;
    case "*": e.preventDefault(); selectAllToggle(); break;
    case "/": e.preventDefault(); { const s = document.querySelector(".comp-search"); if (s) s.focus(); } break;
    case "G": e.preventDefault(); setCursor((STATE.compRows || []).length - 1); break;
    case "g":
      e.preventDefault();
      if (STATE._gReady) { STATE._gReady = false; setCursor(0); } // gg → top
      else { STATE._gReady = true; setTimeout(() => { STATE._gReady = false; }, 600); }
      break;
    case "Escape": if (STATE.compSelected.size) { e.preventDefault(); clearSelection(); } break;
    case "?": e.preventDefault(); showShortcutHelp(); break;
    default:
      if (tabActionKeys().includes(e.key)) { e.preventDefault(); navAction(e.key); }
  }
}

// `*` — select / deselect every row in the current view.
function selectAllToggle() {
  const rows = STATE.compRows || [];
  if (!rows.length) return;
  const allSelected = rows.every((r) => STATE.compSelected.has(r.name));
  rows.forEach((r) => (allSelected ? STATE.compSelected.delete(r.name) : STATE.compSelected.add(r.name)));
  document.querySelectorAll(".nav-row").forEach((el) => {
    const on = STATE.compSelected.has(el.dataset.repo);
    el.classList.toggle("selected", on);
    const cb = el.querySelector(".nav-check");
    if (cb) cb.checked = on;
  });
  updateSelBar();
}

// `y` — copy the repo link(s) (selection, or the cursor row) to the clipboard, rich
// (clickable anchors for Slack) + plain (newline URLs), like the PR-links button.
function kbCopyLinks() {
  const names = selectedOrCursor();
  const byName = new Map((STATE.compRows || []).map((r) => [r.name, r]));
  const repos = names.map((n) => byName.get(n)).filter(Boolean);
  if (!repos.length) return;
  const html = repos.map((r) => anchorHtml(r.url, r.nameWithOwner || r.name)).join("<br>");
  const plain = repos.map((r) => r.url).join("\n");
  copyRich(html, plain, null);
  toast(`Copied ${repos.length} repo link${repos.length > 1 ? "s" : ""}`);
}

// Drop a repo from the inventory after it's archived/deleted, and refresh counts.
function removeComplianceRepo(repo) {
  if (!STATE.complianceData) return;
  STATE.complianceData.repos = STATE.complianceData.repos.filter((r) => r.name !== repo);
  if (STATE.complianceData.archived) STATE.complianceData.archived = STATE.complianceData.archived.filter((r) => r.name !== repo);
  recomputeComplianceSummary();
  drawCompliance();
  renderTabs();
}

// Archived repos table row: read-only, with Unarchive + Delete (no scope/protection).
function archivedRow(r, idx) {
  const sel = STATE.compSelected.has(r.name);
  const cls = "comp-row nav-row" + (idx === STATE.compCursor ? " cursor" : "") + (sel ? " selected" : "");
  const push = r.pushedAt ? relTime(r.pushedAt) : "—";
  return (
    `<tr class="${cls}" data-repo="${esc(r.name)}" data-idx="${idx}">` +
    `<td class="comp-check-col"><input type="checkbox" class="nav-check"${sel ? " checked" : ""} aria-label="select ${esc(r.name)}"></td>` +
    `<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="vis">${esc(r.visibility)}</span> <span class="badge archived-tag">archived</span></td>` +
    `<td class="muted">${esc(push)}</td>` +
    `<td class="muted">—</td>` +
    `<td class="muted">—</td>` +
    `<td class="muted">—</td>` +
    `<td class="prune-cell"><button class="row-unarchive subtle" title="Unarchive — bring it back into the active inventory and scans">↩ Unarchive</button> <button class="row-delete danger" title="Permanently delete this repo on GitHub — irreversible">🗑</button></td>` +
    `</tr>`
  );
}

// Set a repo's engagement classification (Track as) from the Compliance tab, then refresh
// so the derived bits (protection scope/status) catch up with the new engagement.
async function onComplianceClassify(repo, stateWanted) {
  const r = STATE.complianceData.repos.find((x) => x.name === repo);
  const from = (r && r.classification) || "untriaged";
  const to = stateWanted || "untriaged";
  if (from === to) return;
  const meta = await engagementNoteModal({ subject: repo, from, to });
  if (!meta) { drawCompliance(); return; } // cancelled → re-render to reset the <select>
  setRowsBusy([repo]);
  try {
    const data = await postJSON("/api/classify", { repo, state: stateWanted, note: meta.note, sowEndDate: meta.sowEndDate });
    toast(`${repo} tracked as ${engagementLabel(data.state)}.`);
    loadComplianceData(); // re-derive scope/protection with the new classification (clears busy on re-render)
  } catch (e) {
    clearRowBusy();
    alert("Couldn't classify: " + e.message);
  }
}

async function onComplianceUnarchive(repo) {
  if (!(await confirmModal({ message: `Unarchive ${repo}?\n\nIt becomes writable again and re-enters the active inventory and dependency/compliance scans.`, confirmLabel: "↩ Unarchive" }))) return;
  setRowsBusy([repo]);
  try {
    await postJSON("/api/unarchive", { repo });
    if (STATE.complianceData.archived) STATE.complianceData.archived = STATE.complianceData.archived.filter((r) => r.name !== repo);
    drawCompliance();
    renderTabs();
    toast(`${repo} unarchived — Refresh to see it in the active inventory.`);
  } catch (e) {
    clearRowBusy();
    alert("Couldn't unarchive: " + e.message);
  }
}

async function onComplianceArchive(repo) {
  if (!(await confirmModal({ message: `Archive ${repo} on GitHub?\n\nIt becomes read-only and drops out of the active inventory (and GitHub's alert feed). Reversible anytime from the repo's settings.`, confirmLabel: "Archive", rememberKey: "archive" }))) return;
  setRowsBusy([repo]);
  try {
    await postJSON("/api/archive", { repo });
    removeComplianceRepo(repo);
  } catch (e) {
    clearRowBusy();
    alert("Couldn't archive: " + e.message);
  }
}

function complianceRow(r, idx) {
  const push = r.pushedAt ? relTime(r.pushedAt) : "—";
  const sel = STATE.compSelected.has(r.name);
  const cls = "comp-row nav-row" + (idx === STATE.compCursor ? " cursor" : "") + (sel ? " selected" : "");
  const dormant = r.pushedAt && Date.parse(r.pushedAt) < Date.now() - 63072000000 ? ' <span class="dormant-tag">dormant 2y+</span>' : "";
  // gem / published-to-registry indicator
  let typeBadge = "";
  if (r.published && r.published.registry === "rubygems") typeBadge = ` <span class="gem-tag pub" title="Published gem on rubygems.org">💎 rubygems</span>`;
  else if (r.published && r.published.registry === "npm") typeBadge = ` <span class="gem-tag pub" title="Published package on npm">📦 npm</span>`;
  else if (r.isGem) typeBadge = ` <span class="gem-tag" title="Has a .gemspec but isn't published to rubygems">💎 gem · unpublished</span>`;
  // reverse dependency: other org repos that depend on this one
  const deps = (r.dependents || []).length
    ? ` <span class="dep-tag" title="Depended on by: ${esc((r.dependents || []).join(", "))}">↩ used by ${r.dependents.length} repo${r.dependents.length > 1 ? "s" : ""}</span>`
    : "";
  // Branch protection is only tracked for repos we maintain (classification maintained,
  // or pending = maintained in-flight). Everything else shows "—" (not applicable).
  let prot = "<span class='muted' title='Branch protection is only enforced on maintained repos'>—</span>";
  if (r.protectionScope) {
    if (r.protected === true) prot = "<span class='c-ok'>🔒 protected</span>";
    else if (r.protected === false) prot = `<span class='c-warn'>🔓 unprotected</span> <button class="row-protect">Protect</button>`;
    else prot = "<span class='muted'><span class='spin'></span> checking…</span>";
  }
  // SOC 2 scope is DERIVED from engagement (read-only badge); the ⚙ opens the rare override.
  const inScope = r.scope === "in";
  const ov = r.scopeOverride;
  const ovTitle = ov ? `Override: ${ov.reason || "no reason given"} · engagement would derive ${r.scopeDerived === "in" ? "In scope" : "Out of scope"}` : "";
  const toggle =
    `<span class="scope-badge ${inScope ? "in" : "out"}">${inScope ? "In scope" : "Out of scope"}</span>` +
    (ov ? ` <span class="scope-ov" title="${esc(ovTitle)}">override</span>` : "") +
    ` <button class="scope-edit" data-repo="${esc(r.name)}" title="Override SOC 2 scope (rare)">⚙</button>`;
  // Track-as (engagement) — settable here too, so repos with no alerts (which never reach
  // the alert tabs) can still be classified. Empty value = untriaged.
  const cur = r.classification && r.classification !== "untriaged" ? r.classification : "";
  const track =
    `<select class="track-select" aria-label="track ${esc(r.name)}">` +
    `<option value=""${cur ? "" : " selected"} disabled hidden>Track as…</option>` +
    ENGAGEMENTS.map(([v, l]) => `<option value="${v}"${cur === v ? " selected" : ""}>${l}</option>`).join("") +
    `</select>`;
  // Latest engagement-change note (the SOC 2 audit trail) — click for full history.
  const eng = r.engagement;
  const engBadge = eng
    ? ` <button class="eng-badge" data-eng="${esc(r.name)}" title="${esc(engagementLabel(eng.from) + " → " + engagementLabel(eng.to) + " · " + engDate(eng.at) + (eng.note ? " — " + eng.note : ""))}" aria-label="engagement history">📝</button>`
    : "";
  return (
    `<tr class="${cls}" data-repo="${esc(r.name)}" data-idx="${idx}">` +
    `<td class="comp-check-col"><input type="checkbox" class="nav-check"${sel ? " checked" : ""} aria-label="select ${esc(r.name)}"></td>` +
    `<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="vis">${esc(r.visibility)}</span>${typeBadge}${deps}${dormant}</td>` +
    `<td class="muted">${esc(push)}</td>` +
    `<td class="track-cell">${track}${engBadge}</td>` +
    `<td>${prot}</td>` +
    `<td>${toggle}</td>` +
    `<td class="prune-cell"><button class="row-archive subtle" title="Archive on GitHub (read-only, reversible)">Archive</button> <button class="row-delete danger" title="Permanently delete this repo on GitHub — irreversible">🗑</button></td>` +
    `</tr>`
  );
}

async function onRowProtect(repo, btn) {
  const restore = btnBusy(btn, '<span class="spin"></span>…');
  setRowsBusy([repo]); // also covers the keyboard `p` path (no button to spin)
  try {
    await postJSON("/api/protect-branch", { repo });
    const r = STATE.complianceData.repos.find((x) => x.name === repo);
    if (r) r.protected = true;
    recomputeComplianceSummary();
    drawCompliance();
  } catch (e) {
    clearRowBusy();
    alert("Couldn't protect: " + e.message);
    restore();
  }
}

async function onComplianceProtectAll(btn) {
  const targets = STATE.complianceData.repos.filter((r) => r.protectionScope && r.protected === false);
  if (!(await confirmModal({ message: `Apply the SOC 2 ruleset to ${targets.length} unprotected maintained repo(s)?`, confirmLabel: "Protect all" }))) return;
  if (btn) btn.disabled = true;
  let done = 0;
  for (const r of targets) {
    try {
      await postJSON("/api/protect-branch", { repo: r.name });
      r.protected = true;
      done++;
    } catch {
      /* keep going */
    }
    if (btn) btn.innerHTML = `<span class="spin"></span>${done}/${targets.length}…`;
  }
  recomputeComplianceSummary();
  drawCompliance();
}

function recomputeComplianceSummary() {
  const reps = STATE.complianceData.repos;
  STATE.complianceData.summary = {
    total: reps.length,
    inScope: reps.filter((r) => r.scope === "in").length,
    outScope: reps.filter((r) => r.scope === "out").length,
    overridden: reps.filter((r) => r.scopeOverride).length,
    unprotected: reps.filter((r) => r.protectionScope && r.protected === false).length,
  };
}

function render() {
  if (!STATE.model) return;
  renderSummary();
  renderTabs();
  renderCards();
}

// After a single repo is ignored/archived: drop its card, refresh chrome only —
// this preserves any in-progress update log on other cards.
function afterMutation(el) {
  el.remove();
  renderSummary();
  const prevTab = STATE.tab;
  renderTabs(); // may switch STATE.tab if the active tab just got hidden (untriaged→0)
  if (STATE.tab !== prevTab || !partition()[STATE.tab].length) renderCards();
}

// Highlight a repo's card (e.g. the one that just moved to Pending) and bring it
// into view — it may be far down the sorted list.
function flashCard(name) {
  const card = cardEl(name);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("flash");
  void card.offsetWidth; // force reflow so the animation restarts on a repeat move
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 2000);
}

function closeAllMenus() {
  document.querySelectorAll(".dd-menu:not([hidden])").forEach((m) => (m.hidden = true));
}
function toggleMenu(e, trigger) {
  e.stopPropagation();
  const menu = trigger.parentElement.querySelector(".dd-menu");
  const wasOpen = !menu.hidden;
  closeAllMenus();
  menu.hidden = wasOpen;
}
function contactTitle(r) {
  const c = r.contact;
  if (c && (c.name || c.email)) return `${c.name || ""}${c.email ? ` <${c.email}>` : ""}`.trim();
  return "Not configured";
}

// Copy text to the clipboard (works on http://127.0.0.1 — localhost is a secure
// context) with a temp-textarea fallback, and flash "copied" feedback on the button.
// Copy a hyperlink to the clipboard: rich text/html (so Slack renders the linked
// "owner/repo#num" with no bare URL) + a plain-text URL fallback. Falls back to a
// contenteditable selection for browsers without ClipboardItem.
async function copyRich(html, plain, btn, okLabel = "✓ Copied") {
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plain);
    }
  } catch {
    try {
      const div = document.createElement("div");
      div.contentEditable = "true";
      div.innerHTML = html;
      div.style.position = "fixed";
      div.style.opacity = "0";
      document.body.appendChild(div);
      const range = document.createRange();
      range.selectNodeContents(div);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
      sel.removeAllRanges();
      div.remove();
    } catch {}
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = okLabel;
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1500);
  }
}

const prLabel = (r, pr) => `${r.nameWithOwner}#${pr.number}`;
const anchorHtml = (url, label) => `<a href="${esc(url)}">${esc(label)}</a>`;

// Rich HTML (one linked label per line) + plain-text URLs for the whole pending list.
function buildPendingLinks(list) {
  const html = [];
  const plain = [];
  for (const r of list) {
    for (const pr of r.openPRs || []) {
      html.push(anchorHtml(pr.url, prLabel(r, pr)));
      plain.push(pr.url);
    }
  }
  return { html: html.join("<br>"), plain: plain.join("\n") };
}

// "Copy all PR links" + "Open all in browser" bar above the Pending tab's cards.
function pendingToolbar(list) {
  const n = list.reduce((s, r) => s + (r.openPRs ? r.openPRs.length : 0), 0);
  const bar = document.createElement("div");
  bar.className = "pending-toolbar";
  bar.innerHTML =
    `<button class="copy-all">⧉ Copy all ${n} PR link${n > 1 ? "s" : ""}</button>` +
    `<button class="open-all">↗ Open all ${n} in browser</button>` +
    `<span class="toolbar-hint">paste into Slack, or open every PR in your default browser</span>`;
  bar.querySelector(".copy-all").addEventListener("click", (e) => {
    const { html, plain } = buildPendingLinks(list);
    copyRich(html, plain, e.currentTarget, `✓ Copied ${n} link${n > 1 ? "s" : ""}`);
  });
  bar.querySelector(".open-all").addEventListener("click", (e) => onOpenAllPRs(list, e.currentTarget));
  return bar;
}

// Open every pending PR as a new tab in the OS default browser (server-side, so
// it isn't popup-blocked like a loop of window.open() would be).
async function onOpenAllPRs(list, btn) {
  const urls = [];
  for (const r of list) for (const pr of r.openPRs || []) if (pr.url) urls.push(pr.url);
  if (!urls.length) return;
  if (urls.length > 5 && !(await confirmModal({ message: `Open all ${urls.length} pull requests as new browser tabs?`, confirmLabel: "Open all" }))) return;
  const restore = btnBusy(btn, "Opening…");
  try {
    const data = await postJSON("/api/open-urls", { urls });
    btn.textContent = `✓ Opened ${data.opened}`;
    setTimeout(restore, 2000);
  } catch (e) {
    restore();
    alert("Couldn't open the PRs: " + e.message);
  }
}

// Right-aligned severity cluster on the title row: colored text tokens in a fixed
// order, so counts line up and scan vertically down the list. Zero counts are omitted.
function sevTokens(counts) {
  const toks = SEVS.map((s) => {
    const n = counts[s] || 0;
    return n ? `<span class="sev ${s}">${n} ${s}</span>` : "";
  }).join("");
  return toks ? `<span class="ar-sevs">${toks}</span>` : "";
}

// Per-ecosystem breakdown, shown inside the flagged-packages disclosure summary
// (it's a breakdown of that same count, so it lives with it).
function ecoText(eco) {
  return Object.entries(eco)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} ${v}`)
    .join(" · ");
}

function pkgTable(pkgs) {
  const rows = pkgs
    .map(
      (p) => `<tr>
        <td><span class="sev-dot ${esc(p.severity)}"></span>${esc(p.severity)}</td>
        <td>${esc(p.ecosystem)}</td>
        <td><code>${esc(p.pkg)}</code></td>
        <td>${p.patched ? "→ " + esc(p.patched) : "—"}</td>
        <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.ghsa || "view")}</a>` : esc(p.ghsa || "")}</td>
      </tr>`
    )
    .join("");
  return `<table class="pkgs">
      <thead><tr><th>Sev</th><th>Ecosystem</th><th>Package</th><th>Patched</th><th>Advisory</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

function actionsFor(r) {
  if (r.archived) return "";
  const c = r.classification || "untriaged";
  const mode = STATE.emailMode || "mailto";

  // Exposed Track-as buttons only on the Untriaged TAB (where triaging is the job).
  // Everywhere else — including untriaged repos that sit in Pending — the choices
  // live in the "⋯" menu.
  let classifyRow = "";
  if (STATE.tab === "untriaged") {
    classifyRow =
      `<div class="classify"><span class="classify-label">Track as</span>` +
      ENGAGEMENTS.map(([st, lbl]) => `<button class="cls-btn" data-state="${st}">${lbl}</button>`).join("") +
      `</div>`;
  }

  // Emailing a client only makes sense once the repo is a client engagement —
  // maintained (active) or monitored (inactive). Untriaged/ignored don't get it.
  const canEmail = c === "maintained" || c === "monitored";
  const emailLabel = mode === "copy" ? "⧉ Copy email" : "✉ Email client";
  const emailBtn = (primary) => `<button class="${primary ? "primary " : ""}act-email" title="${esc(contactTitle(r))}">${emailLabel}</button>`;

  let ctx = "";
  if (c === "monitored") {
    const notify = r.notifiedAt
      ? `<button class="act-notify" data-clear="false">Re-notify client</button><button class="subtle act-notify" data-clear="true">Clear notice</button>`
      : `<button class="act-notify" data-clear="false">Mark notified</button>`;
    ctx = `${emailBtn(true)} ${notify}`;
  } else if (c !== "ignored") {
    // maintained or untriaged → we patch. A gem's disposition changes the CTA —
    // covered → dismiss the (non-actionable) alerts; blocked → open a constraint-bump
    // PR — but ONLY when there's no open PR yet. An open PR takes precedence: a pending
    // repo (the bump/upgrade/update PR already exists) just gets the normal "Re-run".
    const d = r.disposition;
    if (!r.pending && d && d.state === "covered") {
      ctx =
        `<button class="primary act-dismiss" title="Dismiss these alerts on GitHub as covered-downstream — documented and reversible">✓ Dismiss on GitHub</button> ` +
        `<button class="subtle act-update">Re-check</button>`;
    } else if (!r.pending && d && d.state === "blocked") {
      ctx =
        `<button class="primary act-bump" title="Open a draft PR that raises the blocking gemspec constraints, then let the CI auto-fixer iterate on the breaking changes">⛔ Open constraint-bump PR</button> ` +
        `<button class="subtle act-update">Re-check</button>`;
    } else {
      const upd = r.pending
        ? `<button class="act-update">Re-run update</button>`
        : `<button class="primary act-update">Create update PR</button>`;
      ctx = canEmail ? `${upd} ${emailBtn(false)}` : upd;
    }
  }

  return `${classifyRow}${contactFormHtml(r)}<div class="action-row">${ctx}${moreMenu(r, c, mode)}</div>`;
}

// The "⋯" overflow menu. On triaged repos it leads with the Track-as choices
// (current shown with ✓ and disabled); on Untriaged those are exposed instead.
function moreMenu(r, c, mode) {
  const altLabel = mode === "copy" ? "✉ Open mail draft instead" : "⧉ Copy email instead";
  const altMode = mode === "copy" ? "mailto" : "copy";
  const contactLabel = r.contact && (r.contact.name || r.contact.email) ? "Edit client contact" : "+ Add client contact";
  // Client email/contact actions only for client engagements (maintained/monitored).
  const emailItems =
    c === "maintained" || c === "monitored"
      ? `<button class="menu-contact">${contactLabel}</button>` +
        `<button class="menu-email-alt" data-mode="${altMode}">${altLabel}</button>`
      : "";

  let clsItems = "";
  if (STATE.tab !== "untriaged") {
    clsItems =
      `<div class="menu-section">Track as</div>` +
      ENGAGEMENTS
        .map(([st, lbl]) => {
          const cur = c === st;
          return `<button class="cls-opt${cur ? " active" : ""}" data-state="${st}"${cur ? " disabled" : ""}>${cur ? "✓ " : ""}${lbl}</button>`;
        })
        .join("") +
      `<div class="menu-divider"></div>`;
  }

  return `<div class="dd more-dd">
    <button class="dd-trigger more-btn" data-open title="More">⋯</button>
    <div class="dd-menu" hidden>
      ${clsItems}
      ${emailItems}
      <button class="menu-archive danger">Archive repo</button>
    </div>
  </div>`;
}

// Hidden inline contact editor (revealed from the "⋯" menu).
function contactFormHtml(r) {
  const c = r.contact;
  return `<div class="contact-form" hidden>
    <span class="contact-form-label">Client contact</span>
    <input class="contact-input cname" type="text" placeholder="Client name" value="${esc(c ? c.name : "")}">
    <input class="contact-input cemail" type="email" placeholder="client@email.com" value="${esc(c ? c.email : "")}">
    <button class="primary contact-save">Save</button>
    <button class="subtle contact-cancel">Cancel</button>
  </div>`;
}

function wireContactForm(r, el) {
  const form = el.querySelector(".contact-form");
  if (!form) return;
  form.querySelector(".contact-cancel").addEventListener("click", () => (form.hidden = true));
  form.querySelector(".contact-save").addEventListener("click", async () => {
    const name = form.querySelector(".cname").value.trim();
    const email = form.querySelector(".cemail").value.trim();
    const btn = form.querySelector(".contact-save");
    btn.disabled = true;
    try {
      const data = await postJSON("/api/contact", { repo: r.name, name, email });
      r.contact = data.contact;
      form.hidden = true;
      btn.disabled = false;
      el.querySelectorAll(".act-email").forEach((b) => (b.title = contactTitle(r)));
      const mc = el.querySelector(".menu-contact");
      if (mc) mc.textContent = r.contact && (r.contact.name || r.contact.email) ? "Edit client contact" : "+ Add client contact";
    } catch (e) {
      alert("Failed: " + e.message);
      btn.disabled = false;
    }
  });
}

// One status row: label on the left, optional meta + action right-aligned. `kind`
// colors the label and the row's left tick (warn/danger/stale/ok/info/todo/pr/muted).
function srow(kind, labHtml, right = "", meta = "") {
  const r = (meta ? `<span class="srow-meta">${meta}</span>` : "") + (right || "");
  return (
    `<div class="srow ${kind}"><span class="lab ${kind}">${labHtml}</span>` +
    (r ? `<span class="srow-right">${r}</span>` : "") +
    `</div>`
  );
}

// Status rows near the top of a card (triage prompt / notification trail).
function classifyPrompt(r) {
  // On the Untriaged tab the intro + exposed Track-as buttons already say this —
  // repeating it on every card is noise. Elsewhere (e.g. an untriaged repo sitting
  // in Pending) the nudge still earns its row.
  if (STATE.tab === "untriaged") return "";
  return (r.classification || "untriaged") === "untriaged"
    ? srow("todo", "○ Not yet classified — choose how to track this repo below")
    : "";
}
function monitoredStale(r) {
  return r.classification === "monitored" && r.notifiedAt && r.newAdvisoryCount > 0
    ? srow("stale", `⚠ ${r.newAdvisoryCount} new advisor${r.newAdvisoryCount === 1 ? "y" : "ies"} since you notified the client ${relTime(r.notifiedAt)} — re-notify recommended`)
    : "";
}
function monitoredNotified(r) {
  return r.classification === "monitored" && r.notifiedAt && !(r.newAdvisoryCount > 0)
    ? srow("ok", `✓ Client notified ${relTime(r.notifiedAt)} — documented`)
    : "";
}

// One-line description of what the current alert tab contains — shown once at the top
// so the per-card status banners don't have to restate it.
const TAB_INTROS = {
  maintained: "Repos you actively maintain — open update PRs and keep the default branch protected.",
  pending: "Repos with an open update PR, awaiting review and merge.",
  monitored: "Inactive-client repos you watch but don't patch — email the client, then mark them notified.",
  notified: "Monitored repos whose client has already been emailed about these vulnerabilities.",
  ignored: "Repos that are out of scope for this tool.",
  untriaged: "New repos with alerts — classify each as Maintain, Monitor, or Ignore.",
  covered: "Maintained gems whose constraints already admit every patch — no action needed.",
  compliance: "Full SOC 2 inventory — scope each repo In or Out and track branch protection.",
  archived: "Repos archived on GitHub (read-only).",
};
function tabIntro() {
  return TAB_INTROS[STATE.tab] || "";
}

// Dependency relationships as quiet meta-line segments (full list in the title
// tooltip and the `d` modal when truncated). Only real relationships are shown.
function depMeta(r) {
  const fmt = (names) =>
    names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  const segs = [];
  if (r.dependsOnOrg && r.dependsOnOrg.length)
    segs.push(`<span class="dep-meta" title="depends on org repos: ${esc(r.dependsOnOrg.join(", "))}">→ depends on ${esc(fmt(r.dependsOnOrg))}</span>`);
  if (r.dependents && r.dependents.length)
    segs.push(`<span class="dep-meta" title="depended on by: ${esc(r.dependents.join(", "))}">↩ used by ${esc(fmt(r.dependents))}</span>`);
  return segs;
}

// A PR's review status as a small pill. "Review requested" means a reviewer was actually
// REQUESTED (reviewRequests non-empty) — NOT GitHub's reviewDecision==="REVIEW_REQUIRED",
// which is just the branch-protection baseline ("needs an approving review to merge") that
// every open PR carries and the Pending tab already implies. Approved / changes-requested
// come straight from reviewDecision.
function reviewBadge(pr) {
  if (pr.reviewDecision === "APPROVED") return ` <span class="rev-state approved">✓ approved</span>`;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return ` <span class="rev-state changes">✗ changes requested</span>`;
  const reviewers = pr.reviewers || [];
  if (reviewers.length) {
    const who = ` · ${esc(reviewers.slice(0, 2).join(", "))}${reviewers.length > 2 ? ` +${reviewers.length - 2}` : ""}`;
    return ` <span class="rev-state requested" title="Review requested from ${esc(reviewers.join(", "))}">👀 review requested${who}</span>`;
  }
  return "";
}
// One PR per row: link + review status + the CI check state, all consolidated onto a
// single line (the CI used to be its own row). A failing PR's "Fix CI" button rides in
// the right slot next to Copy.
function prChips(r) {
  if (!r.openPRs || !r.openPRs.length) return "";
  const ci = ciInline(r); // { text, btn } — appended to the first PR row
  return r.openPRs
    .map((pr, i) => {
      const ciText = i === 0 && ci.text ? ` <span class="pr-meta">·</span> ${ci.text}` : "";
      const right =
        (i === 0 ? ci.btn : "") +
        `<button class="copy-btn act-copy-pr" data-url="${esc(pr.url)}" data-label="${esc(r.nameWithOwner + "#" + pr.number)}" title="Copy linked PR reference">⧉ Copy</button>`;
      return srow(
        "pr",
        `🔗 <a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}${pr.draft ? " · draft" : ""} →</a>${reviewBadge(pr)}${ciText}`,
        right
      );
    })
    .join("");
}

// CI check state (from /api/pr-status) as an inline label + an optional right-slot
// button: a "Fix CI" button on failure, or the live "Claude is fixing…" / capped state.
function ciInline(r) {
  const s = STATE.ciStatus[r.name];
  if (!s) return { text: "", btn: "" };
  const labels = {
    passing: "✓ checks passing",
    failing: `✗ ${s.failing.length} check${s.failing.length === 1 ? "" : "s"} failing`,
    pending: "⏳ checks running",
    none: "— no checks",
  };
  if (!labels[s.state]) return { text: "", btn: "" };
  let btn = "";
  if (s.fixing) {
    btn = `<span class="ci-fixing"><span class="spin"></span>Claude is fixing…</span>`;
  } else if (s.state === "failing") {
    btn = s.capped
      ? `<span class="ci-capped" title="Hit the auto-fix attempt cap — needs a human">auto-fix capped</span>`
      : `<button class="ci-fix-btn" title="Launch a headless Claude session to fix the failing checks and push">🔧 Fix CI</button>`;
  }
  const t = s.failing && s.failing.length ? ` title="${esc(s.failing.join(", "))}"` : "";
  const cls = { passing: "ok", failing: "danger", pending: "warn", none: "muted" }[s.state] || "muted";
  return { text: `<span class="ci-inline ${cls}"${t}>${labels[s.state]}</span>`, btn };
}

async function pollPRStatus(refresh) {
  try {
    const data = await getJSON("/api/pr-status" + (refresh ? "?refresh=1" : ""));
    STATE.ciStatus = data.statuses || {};
    STATE.autoFixCI = !!data.autoFixCI;
    renderAutoFixToggle();
    // Merge fresh per-PR draft/review state (kept live by the poll) into the model's
    // openPRs, so review requests / draft→ready flips show without a full Refresh.
    if (data.prMeta && STATE.model) {
      for (const r of STATE.model.repos) {
        const metas = data.prMeta[r.name];
        if (!metas || !r.openPRs) continue;
        for (const pr of r.openPRs) {
          const m = metas.find((x) => x.number === pr.number);
          if (m) { pr.draft = m.draft; pr.reviewDecision = m.reviewDecision; pr.reviewers = m.reviewers; }
        }
      }
    }
    const snap = JSON.stringify(STATE.ciStatus) + "|" + JSON.stringify(data.prMeta || {});
    if (snap !== STATE._ciSnap) {
      STATE._ciSnap = snap;
      if (STATE.tab === "pending" && STATE.model) renderCards(); // refresh badges only on change
    }
  } catch {
    /* server momentarily unavailable */
  }
}

// Header on/off switch for autonomous CI-fixing (instant kill-switch).
function renderAutoFixToggle() {
  let btn = document.getElementById("autofixBtn");
  if (!btn) {
    const ref = document.getElementById("refreshBtn");
    if (!ref) return;
    const anchor = document.getElementById("helpBtn") || ref; // keep ? icon adjacent to Refresh
    btn = document.createElement("button");
    btn.id = "autofixBtn";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/api/autofix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !STATE.autoFixCI }),
        });
        const d = await res.json();
        STATE.autoFixCI = !!d.autoFixCI;
      } catch {}
      btn.disabled = false;
      renderAutoFixToggle();
    });
    anchor.parentNode.insertBefore(btn, anchor);
  }
  btn.className = "autofix-toggle" + (STATE.autoFixCI ? " on" : "");
  btn.title = "Auto-launch a headless Claude session to fix a pending PR when its CI fails";
  btn.textContent = `${STATE.autoFixCI ? "🟢" : "⚪"} Auto-fix CI: ${STATE.autoFixCI ? "on" : "off"}`;
}

// ⚠ End-of-life runtime warning + "Propose upgrade" (from /api/eol-status).
function eolBadge(r) {
  const findings = STATE.eol[r.name];
  if (!findings || !findings.length) return "";
  return findings
    .map((f) =>
      srow(
        "danger",
        `⚠ ${esc(f.id)} <span class="ver">${esc(f.pinned)}</span> is end-of-life${f.eolDate ? ` · ${esc(String(f.eolDate).slice(0, 7))}` : ""} <span class="srow-arrow">→ <span class="ver">${esc(f.target.version)}</span>${f.target.lts ? " LTS" : ""}</span>`,
        `<button class="eol-upgrade-btn" data-id="${esc(f.id)}" title="Open a runtime-upgrade PR: rewrites the pin + regenerates lockfiles under the new version">⬆ Propose upgrade</button>`
      )
    )
    .join("");
}

// Gem disposition, split by zone. covered = quiet/resting; blocked-no-PR = ATTENTION
// (open a bump PR); blocked-with-PR = a calm note for the PR zone.
function dispoCovered(r) {
  const d = r.disposition;
  if (!d || d.state !== "covered") return "";
  const ok = (d.ok || []).slice(0, 8).join(", ");
  const consumers = (r.dependents || []).length ? ` · fixed in consumers: ${(r.dependents || []).map(esc).join(", ")}` : "";
  return srow(
    "ok",
    `✓ Covered upstream — the gemspec already permits the patched versions${ok ? ` (${esc(ok)})` : ""}${consumers}`,
    "",
    d.at ? `resolved ${esc(relTime(d.at))}` : ""
  );
}
function dispoBlockedAlert(r) {
  const d = r.disposition;
  if (!d || d.state !== "blocked" || r.pending) return "";
  const n = (d.blocked || []).length;
  const list = (d.blocked || []).slice(0, 6).join("; ");
  return srow("danger", `⛔ Constraint blocks ${n} patch(es)${list ? ` — ${esc(list)}` : ""}. Needs a gemspec bump + release.`);
}
function dispoBumpNote(r) {
  const d = r.disposition;
  if (!d || d.state !== "blocked" || !r.pending) return "";
  const n = (d.blocked || []).length;
  const list = (d.blocked || []).slice(0, 6).join("; ");
  const prNum = r.openPRs && r.openPRs[0] && r.openPRs[0].number ? ` #${r.openPRs[0].number}` : "";
  return srow("info", `<span${list ? ` title="${esc(list)}"` : ""}>🔧 Constraint-bump PR${prNum} raises the gemspec to admit ${n} blocked patch${n === 1 ? "" : "es"} — review &amp; merge.</span>`);
}

// ---- card status list ---------------------------------------------------------
// One flat list, ordered by urgency: attention items (amber/red ticks, each with its
// action button), then the in-flight PR rows (blue), then resting notes (green/muted).
// The colored left tick per row replaces the old labeled zone boxes.
function statusRows(r) {
  const rows =
    eolBadge(r) + protectionRow(r) + dispoBlockedAlert(r) + classifyPrompt(r) + monitoredStale(r) +
    prChips(r) + dispoBumpNote(r) +
    dispoCovered(r) + monitoredNotified(r);
  return rows ? `<div class="ar-status">${rows}</div>` : "";
}

// Branch-protection: warn + offer to apply the SOC 2 ruleset when the default branch
// is unprotected (mergeable without review). Skipped for archived/ignored repos.
function protectionRow(r) {
  // Only repos we maintain (maintained, or pending = maintained in-flight) are subject
  // to branch protection — never monitored / notified / ignored / untriaged.
  if (r.archived || !(r.classification === "maintained" || r.pending)) return "";
  const st = STATE.protection[r.name];
  if (!st || st.protected !== false) return ""; // unknown or already protected
  return srow(
    "warn",
    `🔓 <strong>${esc(r.defaultBranch || "default branch")}</strong> is unprotected — it can be merged into without a review`,
    `<button class="protect-btn" title="Apply the SOC 2 ruleset: require a reviewed PR (1 approval), block force-push & deletion, no bypass">🛡 Protect branch</button>`
  );
}

async function pollProtectionStatus(refresh) {
  try {
    const data = await getJSON("/api/protection-status" + (refresh ? "?refresh=1" : ""));
    STATE.protection = data.protection || {};
    const snap = JSON.stringify(STATE.protection);
    if (snap !== STATE._protSnap) {
      STATE._protSnap = snap;
      if (STATE.model) renderCards();
    }
  } catch {
    /* server momentarily unavailable */
  }
}

async function onProtectBranch(r, el) {
  if (
    !(await confirmModal({
      confirmLabel: "Protect branch",
      message:
        `Apply the SOC 2 branch-protection ruleset to ${r.nameWithOwner}?\n\n` +
        `Merging into ${r.defaultBranch || "the default branch"} will require a pull request with 1 approval; stale ` +
        `approvals are dismissed on new pushes, conversations must be resolved, and force-pushes & branch deletion are blocked. ` +
        `No one bypasses. Reversible anytime from the repo's Settings → Rules.`,
    }))
  )
    return;
  const restore = btnBusy(el.querySelector(".protect-btn"), '<span class="spin"></span>Protecting…');
  try {
    await postJSON("/api/protect-branch", { repo: r.name });
    STATE.protection[r.name] = { protected: true, via: "ruleset" };
    r.protected = true;
    scheduleRender();
  } catch (e) {
    alert("Couldn't protect the branch: " + e.message);
    restore();
  }
}

async function pollEolStatus(refresh) {
  try {
    const data = await getJSON("/api/eol-status" + (refresh ? "?refresh=1" : ""));
    STATE.eol = data.eol || {};
    STATE.autoUpgradeEOL = !!data.autoUpgradeEOL;
    const snap = JSON.stringify(STATE.eol);
    if (snap !== STATE._eolSnap) {
      STATE._eolSnap = snap;
      if (STATE.model) renderCards(); // EOL can appear on any tab
    }
  } catch {
    /* server momentarily unavailable */
  }
}

async function onUpgradeRuntime(r, id) {
  if (!(await confirmModal({ message: `Open a runtime-upgrade PR for ${r.nameWithOwner}?\n\nIt rewrites the ${id} pin off its end-of-life version and regenerates lockfiles under the new runtime — likely breaking, opens as a draft, and flows into the CI auto-fix loop.`, confirmLabel: "Propose upgrade" })))
    return;
  // Same background-job system as Update PR — show the live run-log on the card.
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: "⏳ Starting runtime upgrade…", level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/upgrade-runtime", { repo: r.name, id });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId;
    job.status = data.status || "queued";
    JOBS.set(r.name, job);
  } catch (e) {
    JOBS.delete(r.name);
    scheduleRender();
    alert("Couldn't start the upgrade: " + e.message);
  }
}

// Covered gem: dismiss its (non-actionable) open alerts on GitHub with a documented
// reason. Reversible; the gem's constraints already permit the patches.
async function onDismissAlerts(r, el) {
  if (
    !(await confirmModal({
      confirmLabel: "Dismiss on GitHub",
      message:
        `Dismiss all ${r.counts.total} open Dependabot alert(s) for ${r.nameWithOwner} on GitHub?\n\n` +
        `Reason: "covered downstream" — this gem's constraints already permit the patched versions, so consuming apps resolve to patched.\n\n` +
        `This writes a documented, reversible dismissal to GitHub. You can reopen any alert later from the Security tab.`,
    }))
  )
    return;
  const restore = btnBusy(el.querySelector(".act-dismiss"), '<span class="spin"></span>Dismissing…');
  try {
    const data = await postJSON("/api/dismiss-alerts", { repo: r.name });
    if (data.failed) {
      alert(`Dismissed ${data.dismissed} of ${data.total}; ${data.failed} failed.\n${data.error || ""}`);
      restore();
      return;
    }
    // All alerts dismissed → the repo has no open alerts left; drop it from the board.
    const idx = STATE.model.repos.indexOf(r);
    if (idx >= 0) STATE.model.repos.splice(idx, 1);
    scheduleRender();
  } catch (e) {
    if (e.status === 412 && e.data && e.data.needsScope) {
      alert(`Your gh token can read alerts but can't dismiss them yet.\n\nRun this once in your terminal, then click Dismiss again:\n\n    ${e.data.hint}`);
    } else {
      alert("Couldn't dismiss the alerts: " + e.message);
    }
    restore();
  }
}

// Blocked gem: open a constraint-bump PR (a headless Claude session raises the
// blocking gemspec constraints and pushes a draft PR). Progress streams to the card.
async function onBumpConstraints(r, el) {
  const n = (r.disposition && r.disposition.blocked && r.disposition.blocked.length) || 0;
  if (
    !(await confirmModal({
      confirmLabel: "Open constraint-bump PR",
      message:
        `Open a constraint-bump PR for ${r.nameWithOwner}?\n\n` +
        `A headless Claude session raises the ${n} blocking gemspec constraint(s) to admit the patched versions, fixes any breaking changes, and pushes a draft PR — which then flows into the CI auto-fix loop. This can be a breaking major upgrade; review carefully.`,
    }))
  )
    return;
  const restore = btnBusy(el.querySelector(".act-bump"), '<span class="spin"></span>Starting…');
  try {
    await postJSON("/api/bump-constraints", { repo: r.name });
  } catch (e) {
    alert("Couldn't start the constraint bump: " + e.message);
    restore();
  }
}

async function onFixCI(r) {
  if (!(await confirmModal({ message: `Launch a headless Claude session to fix the failing CI checks on ${r.nameWithOwner}?\n\nIt edits the PR branch in a local checkout and pushes — CI then re-runs.`, confirmLabel: "Fix CI" }))) return;
  try {
    await postJSON("/api/fix-ci", { repo: r.name });
    pollPRStatus(); // reflect the now-"fixing" state; the session streams into the card
  } catch (e) {
    alert("Couldn't start the fix: " + e.message);
  }
}

// Order a tab's repos as a dependency FOREST: a repo that another repo depends on
// is rendered indented beneath its consumer. Returns [{repo, depth, parentName}].
// Handles multi-level nesting; a shared dependency nests under its first consumer
// (in sort order); cycles fall back to top level.
function nestedOrder(list) {
  const inSet = new Map(list.map((r) => [r.name, r]));
  const childrenOf = new Map(); // parentName -> [childRepo]
  const claimed = new Set(); // child repos already nested under a parent
  for (const p of list) {
    for (const depName of p.dependsOnOrg || []) {
      if (depName === p.name || !inSet.has(depName) || claimed.has(depName)) continue;
      if (!childrenOf.has(p.name)) childrenOf.set(p.name, []);
      childrenOf.get(p.name).push(inSet.get(depName));
      claimed.add(depName);
    }
  }
  const order = [];
  const visited = new Set();
  const walk = (repo, depth, parentName) => {
    if (visited.has(repo.name)) return;
    visited.add(repo.name);
    order.push({ repo, depth, parentName });
    for (const kid of childrenOf.get(repo.name) || []) walk(kid, depth + 1, repo.name);
  };
  for (const r of list) if (!claimed.has(r.name)) walk(r, 0, null); // roots, in sort order
  for (const r of list) if (!visited.has(r.name)) order.push({ repo: r, depth: 0, parentName: null });
  return order;
}

// Worst-state signal for the card's left-edge priority accent: amber if something needs
// your decision, green if a PR is approved (mergeable), blue if a PR is in flight.
function priorityClass(r) {
  if (r.archived) return "";
  if (hasAttention(r)) return " prio-attn";
  if (r.openPRs && r.openPRs.some((p) => p.reviewDecision === "APPROVED")) return " prio-ready";
  if (r.openPRs && r.openPRs.length) return " prio-pr";
  return "";
}
function hasAttention(r) {
  if (r.archived) return false;
  if (STATE.eol[r.name] && STATE.eol[r.name].length) return true;
  if ((r.classification === "maintained" || r.pending) && STATE.protection[r.name] && STATE.protection[r.name].protected === false) return true;
  if (r.disposition && r.disposition.state === "blocked" && !r.pending) return true;
  // Being unclassified is the Untriaged tab's whole premise — an amber bar on every
  // card there distinguishes nothing (same logic as classifyPrompt). Elsewhere
  // (e.g. an untriaged repo sitting in Pending) it still flags the missing triage.
  if (STATE.tab !== "untriaged" && (r.classification || "untriaged") === "untriaged") return true;
  if (r.classification === "monitored" && r.notifiedAt && r.newAdvisoryCount > 0) return true;
  return false;
}
function card(r, nesting) {
  const depth = (nesting && nesting.depth) || 0;
  const el = document.createElement("div");
  const dstate = r.disposition && r.disposition.state;
  el.className =
    "card alert-row nav-row" +
    (r.archived ? " archived" : "") +
    (r.classification === "ignored" ? " ignored" : "") +
    (dstate === "covered" ? " covered" : "") +
    (dstate === "blocked" ? " blocked" : "") +
    priorityClass(r) +
    (depth ? " nested" : "");
  el.dataset.repo = r.name;
  if (depth) el.style.marginLeft = depth * 20 + "px";

  const nestInline =
    nesting && nesting.parentName
      ? ` <span class="nest-inline" title="dependency of ${esc(nesting.parentName)}">↳ ${esc(nesting.parentName)}</span>`
      : "";

  // Identity row (name + tags, severity cluster pinned right), meta+actions row,
  // then the flat status list + package disclosure + run-log (collapse when empty).
  const metaBits = [
    r.language ? esc(r.language) : "",
    r.visibility ? esc(r.visibility.toLowerCase()) : "",
    `base <code>${esc(r.defaultBranch || "?")}</code>`,
    esc(relTime(r.pushedAt)),
    r.published ? `<span class="meta-pub" title="published to ${esc(r.published.registry)}">📦 ${esc(r.published.registry)}</span>` : "",
    ...depMeta(r),
  ].filter(Boolean).join('<span class="meta-sep"> · </span>');
  const eco = ecoText(r.ecosystems);
  el.innerHTML = `
    <input type="checkbox" class="nav-check" aria-label="select ${esc(r.name)}">
    <div class="ar-body">
      <div class="ar-l1">
        <a class="ar-name" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.nameWithOwner)}</a>
        ${r.archived ? '<span class="badge archived-tag">archived</span>' : ""}
        ${r.classification === "ignored" && !r.archived ? '<span class="badge ignored-tag">ignored</span>' : ""}
        ${dstate === "blocked"
          ? r.pending
            ? '<span class="badge disp-pill fixing" title="A constraint-bump PR is open to raise the gemspec — see below">🔧 bump PR open</span>'
            : '<span class="badge disp-pill blocked" title="A gemspec constraint blocks the patched versions — open a constraint-bump PR below">⛔ blocked</span>'
          : ""}${nestInline}
        ${sevTokens(r.counts)}
      </div>
      <div class="ar-l2">
        <span class="ar-meta">${metaBits}</span>
        <span class="ar-actions">${actionsFor(r)}</span>
      </div>
      ${statusRows(r)}
      <details class="disclosure ar-detail"><summary>${r.packages.length} flagged package${r.packages.length === 1 ? "" : "s"}${eco ? `<span class="eco-sum"> · ${eco}</span>` : ""}</summary>${pkgTable(r.packages)}</details>
      <div class="runlog" id="log-${esc(r.name)}"></div>
    </div>`;

  const on = (sel, fn) => {
    const b = el.querySelector(sel);
    if (b) b.addEventListener("click", () => fn(r, el));
  };
  on(".act-update", onUpdate);
  on(".act-dismiss", onDismissAlerts);
  on(".act-bump", onBumpConstraints);
  el.querySelectorAll(".act-email").forEach((b) => b.addEventListener("click", () => onEmail(r, el)));
  el.querySelectorAll(".cls-btn, .cls-opt").forEach((b) =>
    b.addEventListener("click", () => onClassify(r, el, b.dataset.state))
  );
  el.querySelectorAll(".act-notify").forEach((b) =>
    b.addEventListener("click", () => onNotify(r, el, b.dataset.clear === "true"))
  );
  el.querySelectorAll(".dd-trigger").forEach((t) => t.addEventListener("click", (e) => toggleMenu(e, t)));
  const mc = el.querySelector(".menu-contact");
  if (mc) mc.addEventListener("click", () => {
    closeAllMenus();
    const f = el.querySelector(".contact-form");
    if (f) { f.hidden = false; f.querySelector(".cname").focus(); }
  });
  const ma = el.querySelector(".menu-archive");
  if (ma) ma.addEventListener("click", () => { closeAllMenus(); onArchive(r, el); });
  const mea = el.querySelector(".menu-email-alt");
  if (mea) mea.addEventListener("click", () => { closeAllMenus(); onEmail(r, el, mea.dataset.mode); });
  wireContactForm(r, el);
  el.querySelectorAll(".act-copy-pr").forEach((b) =>
    b.addEventListener("click", () => copyRich(anchorHtml(b.dataset.url, b.dataset.label), b.dataset.url, b))
  );
  const fix = el.querySelector(".ci-fix-btn");
  if (fix) fix.addEventListener("click", () => onFixCI(r));
  el.querySelectorAll(".eol-upgrade-btn").forEach((b) => b.addEventListener("click", () => onUpgradeRuntime(r, b.dataset.id)));
  on(".protect-btn", onProtectBranch);
  return el;
}

// ---- actions ----------------------------------------------------------------
async function onClassify(r, el, stateWanted) {
  // Click the active classification again to clear it back to untriaged.
  const next = r.classification === stateWanted ? null : stateWanted;
  const from = r.classification || "untriaged";
  const to = next || "untriaged";
  if (from === to) return;
  const meta = await engagementNoteModal({ subject: r.nameWithOwner || r.name, from, to });
  if (!meta) return; // cancelled — leave classification unchanged
  el.querySelectorAll(".cls-btn, .cls-opt").forEach((b) => (b.disabled = true));
  try {
    const data = await postJSON("/api/classify", { repo: r.name, state: next, note: meta.note, sowEndDate: meta.sowEndDate });
    r.classification = data.state || "untriaged";
    if (STATE.tab === "pending") {
      // A pending repo stays in Pending regardless of classification — re-render in
      // place (keeping scroll) instead of moving the card out of the column.
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    } else {
      afterMutation(el);
    }
  } catch (e) {
    alert("Failed: " + e.message);
    el.querySelectorAll(".cls-btn, .cls-opt").forEach((b) => (b.disabled = false));
  }
}

async function onNotify(r, el, clear) {
  if (clear && !(await confirmModal({ message: `Clear the notified status for ${r.nameWithOwner}? It returns to the Monitored list.`, confirmLabel: "Clear notice" }))) return;
  el.querySelectorAll(".act-notify").forEach((b) => (b.disabled = true));
  try {
    const data = await postJSON("/api/notify", { repo: r.name, clear });
    r.notifiedAt = data.notifiedAt;
    r.newAdvisoryCount = 0;
    afterMutation(el);
  } catch (e) {
    alert("Failed: " + e.message);
    el.querySelectorAll(".act-notify").forEach((b) => (b.disabled = false));
  }
}

async function onArchive(r, el) {
  if (!(await confirmModal({ message: `Archive ${r.nameWithOwner} on GitHub?\n\nIt becomes read-only and drops out of the active audit. You can unarchive later in repo settings.`, confirmLabel: "Archive", rememberKey: "archive" })))
    return;
  const restore = btnBusy(el.querySelector(".menu-archive"), "Archiving…");
  try {
    await postJSON("/api/archive", { repo: r.name });
    r.archived = true;
    afterMutation(el);
  } catch (e) {
    alert("Archive failed: " + e.message);
    restore();
  }
}

// Email action. With no override, uses the configured mode; the "⋯" menu passes
// the alternate mode. mailto: copy the body, then open a mail draft with the
// greeting + gap + sign-off skeleton. copy: just copy the composed email.
async function onEmail(r, el, modeOverride) {
  const btn = el ? el.querySelector(".act-email") : null;
  const prev = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Building…'; }
  try {
    const url = "/api/email?repo=" + encodeURIComponent(r.name) + (modeOverride ? "&mode=" + modeOverride : "");
    const data = await getJSON(url);
    await copyRich(data.clipboardHtml, data.clipboardText, null);
    if (data.mode === "mailto") {
      window.location.href =
        "mailto:" + encodeURIComponent(data.to || "") +
        "?subject=" + encodeURIComponent(data.subject || "") +
        "&body=" + encodeURIComponent(data.mailtoBody || "");
      if (btn) btn.textContent = "✓ Mail opened — body copied, paste in the gap";
    } else {
      if (btn) btn.textContent = "✓ Email copied to clipboard";
    }
    if (btn) {
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); btn.disabled = false; }, 3200);
    }
  } catch (e) {
    if (btn) { btn.textContent = prev; btn.disabled = false; }
    alert("Couldn't build the email: " + e.message);
  }
}

function logLine(box, text, cls) {
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// Kick off a background update-PR job. Returns immediately; progress streams in
// over /api/events (see startEventStream/handleJobEvent), so the work survives
// tab switches and even a full page reload.
async function onUpdate(r, el) {
  if (!(await confirmModal({ message: `Open a dependency-update PR for ${r.nameWithOwner}?\n\nClones the repo, branches, runs lockfile-only updates for the ${r.packages.length} flagged package(s), pushes, and opens a DRAFT pull request. Runs in the background — you can keep working.`, confirmLabel: "Create update PR" })))
    return;
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: "⏳ Starting…", level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/update-pr", { repo: r.name });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId;
    job.status = data.status || "queued";
    JOBS.set(r.name, job);
  } catch (e) {
    JOBS.delete(r.name);
    scheduleRender();
    alert("Couldn't start the update: " + e.message);
  }
}

// "Fix All": start a background job for every eligible repo in one request. The
// server queue caps how many actually run at once; the rest wait their turn.
async function onFixAll(list, btn) {
  const names = list.map((r) => r.name);
  if (!names.length) return;
  if (!(await confirmModal({ message: `Open dependency-update PRs for all ${names.length} repos?\n\nEach is cloned, lockfile-updated, and gets a draft PR. They run ${STATE.maxConcurrent} at a time in the background — you can keep working or even reload; progress resumes.`, confirmLabel: "Open all PRs" })))
    return;
  if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
  for (const n of names) if (!JOBS.has(n)) JOBS.set(n, { status: "queued", events: [{ type: "log", line: "⏳ Queued…", level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/update-all", { repos: names });
    for (const j of data.started || []) {
      const job = JOBS.get(j.repo) || { events: [] };
      job.jobId = j.jobId;
      job.status = j.status;
      JOBS.set(j.repo, job);
    }
    for (const s of data.skipped || []) JOBS.delete(s.repo); // e.g. already had a PR
    reattachJobs();
  } catch (e) {
    for (const n of names) JOBS.delete(n);
    scheduleRender();
    alert("Couldn't start the updates: " + e.message);
  }
}

// Toolbar atop the Untriaged / Maintained tabs to fan out PRs at once.
function fixAllToolbar(list) {
  const bar = document.createElement("div");
  bar.className = "pending-toolbar";
  const eligible = list.filter((r) => !r.pending && !r.archived);
  if (eligible.length < 2) return bar; // a bulk "open for all" only makes sense with 2+ repos
  const n = eligible.length;
  const allLabel = n === 2 ? "both" : `all ${n}`;
  const conc = n <= STATE.maxConcurrent
    ? `runs ${allLabel} at once in the background`
    : `runs ${STATE.maxConcurrent} at a time in the background`;
  bar.innerHTML =
    `<button class="copy-all fix-all">⚡ Open update PRs for ${allLabel}</button>` +
    `<span class="toolbar-hint">clones, lockfile-updates &amp; opens a draft PR per repo — ${conc}</span>`;
  bar.querySelector(".fix-all").addEventListener("click", (e) => onFixAll(eligible, e.currentTarget));
  return bar;
}

// Batch-apply the SOC 2 ruleset to every repo with an unprotected default branch.
function protectAllBar(list) {
  const bar = document.createElement("div");
  bar.className = "pending-toolbar";
  bar.innerHTML =
    `<button class="copy-all protect-all">🛡 Protect all unprotected ${list.length}</button>` +
    `<span class="toolbar-hint">applies the SOC 2 ruleset (reviewed PR · no force-push · no deletion) to every repo whose default branch is unprotected</span>`;
  bar.querySelector(".protect-all").addEventListener("click", (e) => onProtectAll(list, e.currentTarget));
  return bar;
}

async function onProtectAll(list, btn) {
  if (
    !(await confirmModal({
      confirmLabel: `Protect all ${list.length}`,
      message:
        `Apply the SOC 2 branch-protection ruleset to all ${list.length} unprotected repo(s)?\n\n` +
        `${list.map((r) => "• " + r.name).join("\n")}\n\n` +
        `Each will require a reviewed PR (1 approval) to merge; force-pushes & branch deletion blocked; no bypass. ` +
        `Reversible from each repo's Settings → Rules.`,
    }))
  )
    return;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Protecting 0/${list.length}…`; }
  let done = 0;
  const failed = [];
  for (const r of list) {
    try {
      await postJSON("/api/protect-branch", { repo: r.name });
      STATE.protection[r.name] = { protected: true, via: "ruleset" };
      r.protected = true;
      done++;
    } catch (e) {
      failed.push(`${r.name}: ${e.message}`);
    }
    if (btn) btn.innerHTML = `<span class="spin"></span>Protecting ${done}/${list.length}…`;
  }
  if (failed.length) alert(`Protected ${done} of ${list.length}. Failed:\n\n${failed.join("\n")}`);
  scheduleRender();
}

function cardEl(repo) {
  return document.querySelector(`.card[data-repo="${cssEscape(repo)}"]`);
}

// Busy label for a card's CTA button while its background job is queued/running.
function jobBusyHtml(status, kind) {
  if (status === "queued") return "⏳ Queued";
  const label = { fix: "🔧 Fixing CI…", bump: "⛔ Bumping constraints…", upgrade: "⬆ Upgrading…" }[kind] || "Working…";
  return `<span class="spin"></span>${label}`;
}

let _renderTimer = null;
function scheduleRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }, 180);
}

// Single list of the card actions toggled while a job runs, so the disable
// set (reattachJobs) and re-enable sets (finishJob, handleJobEvent) can't drift.
function setCardActionsDisabled(card, on) {
  card
    .querySelectorAll(".cls-btn, .cls-opt, .act-notify, .act-email, .act-dismiss, .dd-trigger")
    .forEach((b) => (b.disabled = on));
}

// Rebuild the live log + disabled-button state for every active job onto the
// currently-rendered cards. Called after each renderCards() and on reconnect.
function reattachJobs() {
  for (const [repo, job] of JOBS) {
    if (job.status === "done" || job.status === "error") continue;
    const card = cardEl(repo);
    if (!card) continue;
    const box = card.querySelector(".runlog");
    if (box) {
      box.classList.add("show");
      box.innerHTML = "";
      for (const ev of job.events) handleEvent(ev, box);
    }
    const btn = card.querySelector(".act-update, .act-bump");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = jobBusyHtml(job.status, job.kind);
    }
    setCardActionsDisabled(card, true);
  }
}

function finishJob(repo, evt) {
  const r = STATE.model && STATE.model.repos.find((x) => x.name === repo);
  JOBS.delete(repo);
  if (evt.prUrl && r) {
    const num = (evt.prUrl.match(/\/pull\/(\d+)/) || [])[1];
    r.pending = true;
    r.openPRs = [{ number: num ? Number(num) : "?", url: evt.prUrl, draft: true }];
    scheduleRender(); // graduates the repo into the Pending PR tab
  } else if (r && evt.disposition) {
    // A gem resolved to covered/blocked — attach the verdict and re-render so it
    // moves to the Covered tab (covered) or shows the constraint-bump CTA (blocked).
    r.disposition = evt.disposition;
    scheduleRender();
  } else {
    // No PR produced (no changes / manual remediation) — re-enable in place.
    const card = cardEl(repo);
    if (card) {
      const btn = card.querySelector(".act-update");
      if (btn) { btn.disabled = false; btn.textContent = "Re-run update"; }
      setCardActionsDisabled(card, false);
    }
  }
}

// Route one event from the global stream to its repo's card + buffer.
function handleJobEvent(evt) {
  if (evt.type === "hello") { if (evt.maxConcurrent) STATE.maxConcurrent = evt.maxConcurrent; return; }
  if (evt.type === "ping") return;
  const repo = evt.repo;
  if (!repo) return;
  let job = JOBS.get(repo);
  if (!job) { job = { jobId: evt.jobId, status: "queued", events: [], kind: evt.kind }; JOBS.set(repo, job); }
  if (evt.kind) job.kind = evt.kind;
  if (evt.jobId) job.jobId = evt.jobId;

  if (evt.type === "status") {
    job.status = evt.status;
    const card = cardEl(repo);
    const btn = card && card.querySelector(".act-update, .act-bump");
    if (btn && (evt.status === "queued" || evt.status === "running")) {
      btn.disabled = true;
      btn.innerHTML = jobBusyHtml(job.status, job.kind);
    }
    return;
  }

  // Renderable events (step/log/error/done): buffer + append live if on screen.
  job.events.push(evt);
  const card = cardEl(repo);
  const box = card && card.querySelector(".runlog");
  if (box) { box.classList.add("show"); handleEvent(evt, box); }

  if (evt.type === "done") {
    if (job.kind === "fix") { JOBS.delete(repo); pollPRStatus(true); } // CI re-runs; refresh badge, don't move
    else finishJob(repo, evt);
  } else if (evt.type === "error") {
    const isFix = job.kind === "fix";
    job.status = "error";
    JOBS.delete(repo);
    const b = card && card.querySelector(".act-update");
    if (b) { b.disabled = false; b.textContent = isFix ? "Re-run update" : "Retry update PR"; }
    if (card) setCardActionsDisabled(card, false);
    if (isFix) pollPRStatus(true);
  }
}

// One global stream carries progress for ALL jobs. Reconnects if dropped; on
// (re)connect the server replays active jobs so the UI re-syncs after a reload.
async function startEventStream() {
  for (;;) {
    try {
      const res = await fetch("/api/events");
      if (!res.ok || !res.body) throw new Error("events " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) { try { handleJobEvent(JSON.parse(line)); } catch {} }
        }
      }
    } catch {
      /* server restarting or stream dropped — fall through to retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
    reattachJobs();
  }
}

function handleEvent(ev, box) {
  if (ev.type === "step") {
    logLine(box, "▸ " + ev.name, "step");
  } else if (ev.type === "log") {
    logLine(box, ev.line, ev.level === "warn" ? "warn" : ev.level === "error" ? "err" : "");
  } else if (ev.type === "error") {
    logLine(box, "ERROR: " + ev.message, "err");
  } else if (ev.type === "done") {
    if (ev.prUrl) {
      logLine(box, "✓ Pull request opened", "success");
      const a = document.createElement("a");
      a.href = ev.prUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "pr-link";
      a.textContent = ev.prUrl;
      box.appendChild(a);
    } else if (ev.changed === false) {
      const n = (ev.notes || []).length;
      logLine(
        box,
        n ? `↑ Couldn't auto-update — ${n} specific note${n > 1 ? "s" : ""} above explain exactly what's needed.` : "No changes produced — nothing flagged here.",
        "warn"
      );
    }
    box.scrollTop = box.scrollHeight;
  }
}

// ---- wire up ----------------------------------------------------------------
// ---- settings modal ---------------------------------------------------------
function estField(key, label, val, step) {
  return `<label class="set-field"><span>${label}</span><input type="number" step="${step}" min="0" data-est="${key}" value="${val}"></label>`;
}
function sigRowHtml(sig, selectedId) {
  const id = esc(sig.id);
  return `<div class="sig-row" data-id="${id}">
    <div class="sig-head">
      <label class="sig-use"><input type="radio" name="selsig" value="${id}" ${sig.id === selectedId ? "checked" : ""}> use</label>
      <input class="sig-label" type="text" placeholder="Label (shown in the picker)" value="${esc(sig.label)}">
      <button class="sig-del" title="Delete signature">✕</button>
    </div>
    <textarea class="sig-body" rows="4" placeholder="Signature lines, exactly as they should appear…">${esc(sig.body)}</textarea>
  </div>`;
}
function settingsHtml(s) {
  const e = s.estimate;
  const m = s.email;
  return `<div class="modal" role="dialog" aria-label="Settings">
    <div class="modal-head"><h2>Settings</h2><button class="modal-close" title="Close">✕</button></div>
    <div class="modal-body">
      <section>
        <h3>Estimate</h3>
        <p class="set-hint">Sizes the hourly engagement quoted in client emails.</p>
        <div class="set-grid">
          ${estField("hourly_rate", "Hourly rate ($)", e.hourly_rate, "5")}
          ${estField("setup_hours", "Setup (hrs)", e.setup_hours, "0.25")}
          ${estField("patch_hours", "Patch update (hrs)", e.patch_hours, "0.25")}
          ${estField("minor_hours", "Minor update (hrs)", e.minor_hours, "0.25")}
          ${estField("major_hours", "Major update (hrs)", e.major_hours, "0.25")}
          ${estField("unknown_hours", "Default / unconfirmed (hrs)", e.unknown_hours, "0.25")}
          ${estField("low_multiplier", "Range low ×", e.low_multiplier, "0.05")}
          ${estField("high_multiplier", "Range high ×", e.high_multiplier, "0.05")}
        </div>
      </section>
      <section>
        <h3>Email action</h3>
        <p class="set-hint">What the “✉ Email client” button does.</p>
        <label class="radio-row"><input type="radio" name="emailmode" value="mailto" ${m.mode === "mailto" ? "checked" : ""}> Open a mail draft (greeting + sign-off skeleton) and copy the body to paste into the gap</label>
        <label class="radio-row"><input type="radio" name="emailmode" value="copy" ${m.mode === "copy" ? "checked" : ""}> Copy the whole email to the clipboard only</label>
        <div class="copy-opts">
          <span class="copy-opts-label">Copy-only includes:</span>
          <label><input type="checkbox" data-emailopt="copy_include_address" ${m.copy_include_address ? "checked" : ""}> address</label>
          <label><input type="checkbox" data-emailopt="copy_include_subject" ${m.copy_include_subject ? "checked" : ""}> subject</label>
          <label><input type="checkbox" data-emailopt="copy_include_signature" ${m.copy_include_signature ? "checked" : ""}> signature</label>
        </div>
      </section>
      <section>
        <h3>Email signatures</h3>
        <p class="set-hint">Select which one client emails use. Add, edit, or delete freely.</p>
        <div class="sig-list">${s.signatures.map((sig) => sigRowHtml(sig, s.selected_signature)).join("")}</div>
        <button class="sig-add">+ Add signature</button>
      </section>
    </div>
    <div class="modal-foot">
      <span class="save-msg"></span>
      <button class="modal-cancel">Cancel</button>
      <button class="primary modal-save">Save</button>
    </div>
  </div>`;
}
function collectSettings(overlay) {
  const estimate = {};
  overlay.querySelectorAll("[data-est]").forEach((inp) => (estimate[inp.dataset.est] = parseFloat(inp.value)));
  const signatures = [];
  overlay.querySelectorAll(".sig-row").forEach((row) =>
    signatures.push({
      id: row.dataset.id,
      label: row.querySelector(".sig-label").value.trim(),
      body: row.querySelector(".sig-body").value,
    })
  );
  const email = {
    mode: (overlay.querySelector('input[name="emailmode"]:checked') || {}).value || "mailto",
    copy_include_address: overlay.querySelector('[data-emailopt="copy_include_address"]').checked,
    copy_include_subject: overlay.querySelector('[data-emailopt="copy_include_subject"]').checked,
    copy_include_signature: overlay.querySelector('[data-emailopt="copy_include_signature"]').checked,
  };
  const sel = overlay.querySelector('input[name="selsig"]:checked');
  return { estimate, email, signatures, selected_signature: sel ? sel.value : signatures[0] && signatures[0].id };
}
async function openSettings() {
  let s;
  try {
    s = await getJSON("/api/settings");
  } catch {
    alert("Couldn't load settings");
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = settingsHtml(s);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector(".modal-cancel").addEventListener("click", close);
  const wireDel = (row) => row.querySelector(".sig-del").addEventListener("click", () => row.remove());
  overlay.querySelectorAll(".sig-row").forEach(wireDel);
  overlay.querySelector(".sig-add").addEventListener("click", () => {
    const id = "sig-" + Math.random().toString(36).slice(2, 8);
    const tmp = document.createElement("div");
    tmp.innerHTML = sigRowHtml({ id, label: "", body: "" }, null);
    const row = tmp.firstElementChild;
    overlay.querySelector(".sig-list").appendChild(row);
    wireDel(row);
    row.querySelector(".sig-label").focus();
  });
  overlay.querySelector(".modal-save").addEventListener("click", async () => {
    const btn = overlay.querySelector(".modal-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const saved = await postJSON("/api/settings", collectSettings(overlay));
      STATE.emailMode = (saved.email && saved.email.mode) || "mailto";
      if (STATE.model) render();
      overlay.querySelector(".save-msg").textContent = "✓ Saved";
      setTimeout(close, 600);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Save";
      overlay.querySelector(".save-msg").textContent = "✕ " + e.message;
    }
  });
}

$("#settingsBtn").addEventListener("click", openSettings);
$("#helpBtn").addEventListener("click", showShortcutHelp);

$("#refreshBtn").addEventListener("click", () => {
  loadHealth();
  loadRepos(true);
  pollEolStatus(true);
  pollProtectionStatus(true);
  // Force a full compliance re-scan only when you're on that tab (it's the slow one);
  // elsewhere just refresh from cache so the badge stays current. Always background.
  loadComplianceData(STATE.tab === "compliance");
});

// Close any open card dropdown when clicking outside it.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dd")) closeAllMenus();
});

// Keyboard navigation (j/k move, x select, search, per-tab actions, ? help) — all tabs.
document.addEventListener("keydown", navKeydown);
// Global: h / l move between tabs (works on every tab).
document.addEventListener("keydown", tabNavKeydown);

async function loadEmailMode() {
  try {
    const s = await getJSON("/api/settings");
    STATE.emailMode = (s.email && s.email.mode) || "mailto";
  } catch {
    STATE.emailMode = "mailto";
  }
}

(async () => {
  await loadEmailMode();
  startEventStream(); // global background-job progress (fire-and-forget loop)
  loadHealth();
  await loadRepos(false);
  pollPRStatus(true); // CI status for pending PRs
  pollEolStatus(true); // end-of-life runtime scan
  pollProtectionStatus(); // branch-protection status (badges unprotected repos)
  loadComplianceData(); // pre-load the compliance inventory in the background (silent)
  setInterval(() => pollPRStatus(), 30000);
  setInterval(() => pollEolStatus(), 120000);
})();
