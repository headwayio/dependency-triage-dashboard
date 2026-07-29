"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode / disabled */ } };
const SEVS = ["critical", "high", "medium", "low"];
// Archived repos drop out of GitHub's alert feed entirely, so there's no archived
// tab. Repos with an open tool PR move through three lifecycle tabs as they progress:
// "Pending PR" (CI failing/running, or being fixed) → "Passing PR" (CI green, not yet
// approved) → "Approved PR" (reviewed, ready to merge).
const TABS = [
  { key: "untriaged", label: "Untriaged" },
  { key: "maintained", label: "Maintained" },
  { key: "pending", label: "Pending PR" },
  { key: "passing", label: "Passing PR" },
  { key: "approved", label: "Approved PR" },
  { key: "covered", label: "Covered" },
  { key: "monitored", label: "Monitored" },
  { key: "notified", label: "Notified" },
  { key: "compliance", label: "🛡 Compliance" },
  { key: "ignored", label: "Ignored" },
];
// Tabs that only appear once they hold something (resting/catch-all buckets). The three
// PR-lifecycle tabs (Pending/Passing/Approved) always show, so the bar is stable and a PR
// visibly advances through fixed columns rather than tabs popping in and out.
const HIDE_WHEN_EMPTY = new Set(["untriaged", "covered"]);
// Tabs that are about a DECISION rather than about vulnerabilities, so they also cover
// repos with no open alerts — pulled from the full org inventory (see withoutAlerts).
// Each key doubles as the classification it matches.
const LITE_TABS = new Set(["untriaged", "ignored"]);
// The three PR-lifecycle tabs — they share CI/review polling, the PR toolbar, and
// the branch-protection bar. Bucketing among them depends on live CI + review state.
const PR_TABS = new Set(["pending", "passing", "approved"]);
// Engagement (Track-as) states + action labels — MUST match lib/state.js VALID (the
// /api/classify contract). NOTE: TABS above intentionally uses different display text
// ("Maintained" vs "Maintain"); do not derive one from the other.
const ENGAGEMENTS = [["maintained", "Maintain"], ["monitored", "Monitor"], ["ignored", "Ignore"]];
const ENG_LABEL = Object.fromEntries(ENGAGEMENTS);
const ENG_RANK = Object.fromEntries(ENGAGEMENTS.map(([k], i) => [k, i]));
// The Compliance tab is its own full-org inventory (not driven by the alert model).
let STATE = { model: null, tab: "maintained", maxConcurrent: 3, ciStatus: {}, autoFixCI: false, maxAttempts: 2, eol: {}, autoUpgradeEOL: false, protection: {}, complianceData: null, complianceFilter: lsGet("compliance.filter", "all"), compSearch: lsGet("compliance.search", ""), compSort: { key: lsGet("compliance.sortKey", ""), dir: Number(lsGet("compliance.sortDir", "1")) || 1 }, alertSearch: "", compRows: [], compCursor: 0, compSelected: new Set() };
// Hydrate the last-known CI status from the previous session so PRs render in their
// correct lifecycle tab (Pending vs Passing) on the FIRST paint, instead of all landing
// in Pending until the CI poll completes a few seconds later. The poll then corrects any
// repo whose CI changed since. Stale entries for repos no longer pending are ignored —
// bucketing requires r.pending from the (server-cached) model regardless.
try { STATE.ciStatus = JSON.parse(lsGet("ci.status", "{}")) || {}; } catch { /* corrupt/absent cache */ }
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

// A single PR's lifecycle state, in precedence order: APPROVED (reviewed → ready to
// merge) > PASSING (green CI, not yet approved) > pending (CI running/failing/unknown).
// CI comes from the per-PR pr.ci that pollCI stamps; the repo-level STATE.ciStatus is only
// a cold-load fallback before the first poll has attached per-PR status.
function prLifecycleState(pr, repo) {
  if (pr.reviewDecision === "APPROVED") return "approved";
  const ci = (pr.ci && pr.ci.state) || (STATE.ciStatus[repo.name] && STATE.ciStatus[repo.name].state);
  return ci === "passing" ? "passing" : "pending";
}

// A kickoff job (open one/more PRs for blocked/major work) is in flight for this repo.
// Keeps the repo in its worklist tab so the orchestration log stays visible until the
// run finishes — without this, a majors-only repo would drop out the instant its last
// PR lands (needsKickoff → false), cutting the monitoring short mid-run.
const KICKOFF_KINDS = new Set(["major", "unblock", "bump"]);
function hasActiveKickoffJob(r) {
  const j = JOBS.get(r.name);
  return !!(j && KICKOFF_KINDS.has(j.kind) && j.status !== "done" && j.status !== "error");
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
  // PR-lifecycle bucketing is PER PR: a repo with PRs in different states appears in EACH
  // matching tab (so a failing PR is never hidden behind an approved sibling). A tab holds
  // the repos that have ≥1 PR in that state; the card there shows only that state's PRs
  // (prChips filters by STATE.tab) while keeping all the repo detail — flagged packages,
  // the live CI-fix log, blocked/major tables. hasPRIn = "this repo has a PR in <state>".
  const hasPRIn = (r, st) => (r.openPRs || []).some((pr) => prLifecycleState(pr, r) === st);
  // Uninitiated maintenance: blocked advisories needing an unblock, or majors that still
  // need a PR. This is NEW work to kick off — it belongs in the worklist (Maintained, or
  // Triage if not yet classified), NOT in the PR-lifecycle tabs, even when the repo also
  // has open PRs. So a kickoff repo surfaces in its classification tab regardless of
  // `pending`; once every advisory has a PR (or is merged), needsKickoff() goes false and
  // it drops back out, living only in the PR tabs for its in-flight PRs.
  // Blocked counts as kickoff work only until an unblock PR is open — one
  // `dependency-unblock/` PR covers every blocked advisory, so once it exists the work is
  // launched (it just hasn't merged, so the advisories still sit below their floor). Mirrors
  // the majors clause (majorsNeedingPR), which already subtracts majors that have a PR.
  // A rollup supersedes ALL kickoff work: it consolidates the approved unblock/major PRs
  // into one `release/deps-` PR and CLOSES the originals — so their branches vanish and the
  // blocked/major detection would otherwise wrongly re-fire. While that release PR is open
  // the consolidated work is in flight, so suppress kickoff (an actively-running job still
  // pins, so its log stays visible). The advisories clear for real when the release merges.
  const needsKickoff = (r) =>
    hasActiveKickoffJob(r) ||
    (!openToolPRs(r, "release/deps-").length && (
      (r.blocked && r.blocked.length && !openToolPRs(r, "dependency-unblock/").length) ||
      majorsNeedingPR(r, dedupeMajors((r.packages || []).filter((p) => p.majorRequired))).length > 0
    ));
  return {
    untriaged: active.filter((r) => cls(r) === "untriaged" && (!r.pending || needsKickoff(r))),
    maintained: active.filter((r) => cls(r) === "maintained" && !covered(r) && (!r.pending || needsKickoff(r))),
    pending: active.filter((r) => r.pending && hasPRIn(r, "pending")),
    passing: active.filter((r) => r.pending && hasPRIn(r, "passing")),
    approved: active.filter((r) => r.pending && hasPRIn(r, "approved")),
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
  // "To maintain" counts REPOS: Maintained + every repo with an open PR. A repo can sit in
  // more than one PR-lifecycle bucket (PRs in different states), so count unique pending
  // repos directly rather than summing the buckets (which would double-count).
  const prRepos = ((STATE.model && STATE.model.repos) || []).filter((r) => !r.archived && r.pending);
  // A kickoff repo can now be in BOTH Maintained and a PR bucket — dedupe by name so it
  // counts once toward "to maintain".
  const uniq = new Map();
  for (const r of [...p.maintained, ...prRepos]) uniq.set(r.name, r);
  const t = summaryOf([...uniq.values()]);

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
  // Untriaged and Ignored also hold repos with no open alerts, which live in the inventory
  // rather than the alert model — so the total has to fold both in. Getting this wrong on
  // Untriaged doesn't just under-count: an org whose only unclassified repos are alert-free
  // would fail the hide-when-empty test below and never show a Triage tab at all.
  const total = (key) => p[key].length + (LITE_TABS.has(key) ? withoutAlerts(key).length : 0);
  // Untriaged is the default catch-all bucket — hide its tab when empty (it
  // reappears the moment a repo lands there again). Every other tab always shows
  // so its count stays visible at a glance.
  const tabs = TABS.filter((t) => !HIDE_WHEN_EMPTY.has(t.key) || total(t.key) > 0);
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
    return total(t.key);
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
        if (PR_TABS.has(STATE.tab)) pollPRStatus(true); // freshen CI/review badges on entry
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
  // Untriaged and Ignored also surface repos with NO open alerts — they never reach the
  // alert model, so we pull them from the full inventory and render them as compact rows.
  // That inventory is pre-loaded on boot, but a tab switch can beat it: kick the load so
  // the tab fills in rather than claiming everything is classified.
  const lite = LITE_TABS.has(STATE.tab);
  if (lite && !STATE.complianceData) loadComplianceData();
  const extraLite = lite
    ? withoutAlerts(STATE.tab).filter((r) => !q || r.name.toLowerCase().includes(q))
    : [];
  if (!full.length && !extraLite.length) {
    const msg = {
      untriaged: "Nothing to triage — every repo is classified 🎉",
      maintained: "No actively-maintained repos with open alerts 🎉",
      pending: "No update PRs in progress. Create one from a Maintained repo and it'll land here while CI runs.",
      passing: "No PRs with green CI awaiting review. A pending PR moves here once its checks pass.",
      approved: "Nothing ready to merge yet. A PR moves here once it's approved.",
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
  // Maintained + the PR-lifecycle tabs surface the "protect all unprotected" bar.
  if (STATE.tab === "maintained" || PR_TABS.has(STATE.tab)) {
    const unprotected = (STATE.model.repos || []).filter(
      (r) => !r.archived && (r.classification === "maintained" || r.pending) && STATE.protection[r.name] && STATE.protection[r.name].protected === false
    );
    if (unprotected.length) content.appendChild(protectAllBar(unprotected));
  }
  // PR-lifecycle tabs get a copy/open-all bar scoped to THIS tab's PRs (the ones each
  // visible card actually shows — i.e. PRs whose state matches the tab).
  if (PR_TABS.has(STATE.tab)) {
    const entries = list.flatMap((r) =>
      (r.openPRs || []).filter((pr) => prLifecycleState(pr, r) === STATE.tab).map((pr) => ({ repo: r, pr }))
    );
    if (entries.length) content.appendChild(prEntryToolbar(entries));
  }
  if (STATE.tab === "untriaged" || STATE.tab === "maintained") content.appendChild(fixAllToolbar(full));

  const ordered = nestedOrder(list);
  STATE.compRows = ordered.map((o) => o.repo);
  STATE.compCursor = Math.max(0, Math.min(STATE.compCursor, STATE.compRows.length - 1));
  const grid = document.createElement("div");
  grid.className = "grid";
  if (!ordered.length && !extraLite.length) {
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
  // Compact rows for repos with no open alerts (continue the cursor index past the cards).
  if (extraLite.length) {
    const base = STATE.compRows.length;
    extraLite.forEach((r, j) => {
      const c = liteCard(r, STATE.tab);
      const idx = base + j;
      c.dataset.idx = idx;
      if (idx === STATE.compCursor) c.classList.add("cursor");
      if (STATE.compSelected.has(r.name)) { c.classList.add("selected"); const cb = c.querySelector(".nav-check"); if (cb) cb.checked = true; }
      grid.appendChild(c);
    });
    STATE.compRows = STATE.compRows.concat(extraLite);
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
  // Track-as on an alert-free untriaged row. These repos live only in the inventory, so
  // they classify through the same path the Compliance tab uses, not the card's onClassify
  // (which mutates an alert-model repo that doesn't exist here).
  grid.querySelectorAll(".lite-cls").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onComplianceClassify(e.currentTarget.closest("[data-repo]").dataset.repo, e.currentTarget.dataset.state);
    })
  );
  bar.querySelectorAll(".comp-selbar [data-kb]").forEach((b) => b.addEventListener("click", () => navAction(b.dataset.kb)));
  wireSearch(bar, (v) => { STATE.alertSearch = v; }, renderCards); // term is ephemeral (cleared on tab switch)
  reattachJobs(); // restore live logs for any in-flight update jobs
  scrollCursorIntoView();
}

// Copy / open-all for exactly the PRs shown in THIS PR-lifecycle tab (the ones whose state
// matches the tab, across every visible card). Open goes server-side so it isn't popup-blocked.
function prEntryToolbar(entries) {
  const n = entries.length;
  const bar = document.createElement("div");
  bar.className = "pending-toolbar";
  bar.innerHTML =
    `<button class="copy-all">⧉ Copy all ${n} PR link${n === 1 ? "" : "s"}</button>` +
    `<button class="open-all">↗ Open all ${n} in browser</button>` +
    `<span class="toolbar-hint">paste into Slack, or open every PR in your default browser</span>`;
  bar.querySelector(".copy-all").addEventListener("click", (e) => {
    const html = entries.map((x) => anchorHtml(x.pr.url, prLabel(x.repo, x.pr))).join("<br>");
    const plain = entries.map((x) => x.pr.url).join("\n");
    copyRich(html, plain, e.currentTarget, `✓ Copied ${n} link${n === 1 ? "" : "s"}`);
  });
  bar.querySelector(".open-all").addEventListener("click", async (e) => {
    const urls = entries.map((x) => x.pr.url).filter(Boolean);
    if (!urls.length) return;
    if (urls.length > 5 && !(await confirmModal({ message: `Open all ${urls.length} pull requests as new browser tabs?`, confirmLabel: "Open all" }))) return;
    const btn = e.currentTarget;
    const restore = btnBusy(btn, "Opening…");
    try {
      const data = await postJSON("/api/open-urls", { urls });
      btn.textContent = `✓ Opened ${data.opened}`;
      setTimeout(restore, 2000);
    } catch (err) {
      restore();
      alert("Couldn't open the PRs: " + err.message);
    }
  });
  return bar;
}

// Repos with NO open alerts never enter the alert model at all, so the two tabs that are
// about a *decision* rather than about vulnerabilities would silently miss them: a repo
// nobody has classified yet, and one already ignored, are both perfectly likely to have
// nothing flagged. Pull those from the full inventory (the Compliance data — every
// non-archived org repo) so each tab shows the complete set. The tab key doubles as the
// classification to match, and repos already in the alert model are excluded so a repo
// never renders twice.
function withoutAlerts(classification) {
  const d = STATE.complianceData;
  if (!d || !d.repos) return [];
  const inModel = new Set(((STATE.model && STATE.model.repos) || []).map((r) => r.name));
  return d.repos.filter((r) => (r.classification || "untriaged") === classification && !inModel.has(r.name));
}

// Compact card for an alert-free repo — there's no alert data to show, just identity and
// the one decision its tab is for: Track-as on Untriaged, undo on Ignored.
function liteCard(r, kind) {
  const el = document.createElement("div");
  el.className = "card alert-row nav-row lite-row" + (kind === "ignored" ? " ignored" : "");
  el.dataset.repo = r.name;
  const push = r.pushedAt ? relTime(r.pushedAt) : "—";
  const tag =
    kind === "ignored"
      ? `<span class="badge ignored-tag">ignored</span>`
      : `<span class="badge untriaged-tag">untriaged</span>`;
  const actions =
    kind === "ignored"
      ? `<button class="row-unignore">Un-ignore</button>`
      : `<div class="classify"><span class="classify-label">Track as</span>` +
        ENGAGEMENTS.map(([st, lbl]) => `<button class="cls-btn lite-cls" data-state="${st}">${lbl}</button>`).join("") +
        `</div>`;
  el.innerHTML =
    `<input type="checkbox" class="nav-check" aria-label="select ${esc(r.name)}">` +
    `<div class="ar-body">` +
    `<div class="ar-l1">` +
    `<a class="ar-name" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` +
    tag +
    `<span class="muted">· no open alerts</span>` +
    `</div>` +
    `<div class="ar-l2"><span class="ar-meta">${r.visibility ? esc(r.visibility.toLowerCase()) + " · " : ""}last push ${esc(push)}</span>` +
    `<span class="ar-actions">${actions}</span></div>` +
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
    else if (LITE_TABS.has(STATE.tab)) renderCards(); // alert-free untriaged/ignored repos live in the inventory
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
    blocked: (r) => r.dependabot && (r.dependabot.state === "blocked" || r.dependabot.state === "stale"),
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
    // Exception state — shown only when it's non-zero, unlike the standing buckets above.
    // A permanent "Dependabot blocked 0" would read as noise; its appearing at all is the alarm.
    ...(s.dependabotBlocked + (s.dependabotStale || 0)
      ? [["blocked", "⚠ Dependabot silent", s.dependabotBlocked + (s.dependabotStale || 0)]]
      : []),
    ["all", "All", s.total],
    ["archived", "Archived", (d.archived || []).length],
  ];
  // Every repo a blocked repo is waiting on — the exact set to grant Dependabot access to.
  const blockers = [...new Set(d.repos.flatMap((r) => (r.dependabot && r.dependabot.blockedBy) || []))].sort();
  // Ecosystems that have simply stopped running, worst (longest quiet) first.
  const staleRows = d.repos
    .filter((r) => r.dependabot && r.dependabot.state === "stale")
    .flatMap((r) => (r.dependabot.stale || []).map((s2) => ({ repo: r.name, ...s2 })))
    .sort((a, b) => (b.ageDays == null ? 1e9 : b.ageDays) - (a.ageDays == null ? 1e9 : a.ageDays));

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
        `</div>` +
        // This is a "your scanning is lying to you" warning, not a to-do — it can't be
        // fixed from here (granting access is an org setting), so it states the blast
        // radius and names the exact repos to grant rather than offering a button.
        (s.dependabotBlocked
          ? `<div class="comp-warn">⚠ <strong>Dependabot is silently broken on ${s.dependabotBlocked} repo${s.dependabotBlocked === 1 ? "" : "s"}.</strong> ` +
            `It can't clone ${blockers.map((b) => `<code>${esc(b)}</code>`).join(", ")}, so dependency resolution fails and <em>every</em> update there is skipped — security ones included. ` +
            `Their alert counts are not trustworthy. Fix: grant Dependabot read access to ${blockers.length === 1 ? "that repo" : "those repos"} ` +
            `(org Settings → Code security → Dependabot private repository access). ` +
            `<button class="comp-warn-link" data-filter="blocked">Show the affected repos</button></div>`
          : "") +
        // Separate banner from the blocked one: same symptom (no updates), different cause
        // and different fix, so merging them would muddle both.
        (staleRows.length
          ? `<div class="comp-warn stale">⏱ <strong>${staleRows.length} configured ecosystem${staleRows.length === 1 ? " has" : "s have"} stopped running.</strong> ` +
            `Dependabot is scheduled for ${staleRows.length === 1 ? "it" : "them"} but hasn't produced a version-update job in a while — no error, just silence. ` +
            `Common causes: <code>open-pull-requests-limit</code> reached (merge or close the open ones), or GitHub pausing the schedule. ` +
            `<div class="stale-list">` +
            staleRows
              .slice(0, 6)
              .map(
                (x) =>
                  `<span><code>${esc(x.repo)}</code> · ${esc(x.ecosystem)} · ` +
                  (x.ageDays == null ? "never run" : `last ran ${x.ageDays}d ago`) +
                  // When we know the cause, lead with it — "at the limit" turns this from
                  // "go investigate" into "merge or close those five".
                  (x.atLimit
                    ? ` · <strong class="stale-cause">${x.openPRs} open PRs, at the limit of ${x.prLimit}</strong>`
                    : x.openPRs != null
                      ? ` · ${x.openPRs} open PR${x.openPRs === 1 ? "" : "s"} of ${x.prLimit}`
                      : "") +
                  ` <span class="muted">(${esc(x.interval)}, flagged past ${x.staleAfterDays}d)</span></span>`
              )
              .join("") +
            (staleRows.length > 6 ? `<span class="muted">…and ${staleRows.length - 6} more</span>` : "") +
            `</div>` +
            `<button class="comp-warn-link" data-filter="blocked">Show the affected repos</button></div>`
          : "")) +
    `<div class="comp-selbar"${STATE.compSelected.size ? "" : " hidden"}>${STATE.compSelected.size ? selBarHtml() : ""}</div>` +
    `<table class="comp-table">${thead}<tbody>` +
    rows.map((r, i) => (onArchived ? archivedRow(r, i) : complianceRow(r, i))).join("") +
    `</tbody></table>` +
    (rows.length === 0 ? `<div class="empty">${onArchived ? "No archived repos." : "No repos in this view 🎉"}</div>` : "");

  content.querySelectorAll(".comp-tab, .comp-warn-link").forEach((b) =>
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
    const pb = tr.querySelector(".prot-open");
    if (pb) pb.addEventListener("click", () => onRowProtect(tr.dataset.repo, pb));
    const ul = tr.querySelector(".prot-lock");
    if (ul) ul.addEventListener("click", () => onRowUnprotect(tr.dataset.repo, ul));
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
  // Untriaged leads with the three Track-as choices — with a whole org to classify, doing
  // it one card at a time is the slow path.
  const track =
    `<button class="selbar-btn" data-kb="m">Maintain <kbd>m</kbd></button> ` +
    `<button class="selbar-btn" data-kb="w">Monitor <kbd>w</kbd></button> ` +
    `<button class="selbar-btn" data-kb="i">Ignore <kbd>i</kbd></button> `;
  const btns =
    STATE.tab === "compliance"
      ? `<button class="selbar-btn" data-kb="e">Archive <kbd>e</kbd></button> ` +
        `<button class="selbar-btn" data-kb="s">Out of scope <kbd>s</kbd></button> ` +
        `<button class="selbar-btn" data-kb="n">Needs compliance <kbd>n</kbd></button> `
      : (STATE.tab === "untriaged" ? track : "") +
        `<button class="selbar-btn" data-kb="e">Archive <kbd>e</kbd></button> ` +
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
  // Triaging is the Untriaged tab's whole job, and it's the one alert tab whose rows can be
  // alert-free inventory repos — so it takes Compliance's Track-as mnemonics. `m` means
  // Maintain here rather than "mark ready for review" (a PR action that belongs to the PR
  // tabs, and is still on the card's own button).
  if (STATE.tab === "untriaged") {
    if (key === "m") return kbTrack("maintained");
    if (key === "w") return kbTrack("monitored");
    if (key === "i") return kbTrack("ignored");
  }
  if (key === "e") return kbArchiveAlert();
  if (key === "#") return kbDelete();
  if (key === "r") return kbEmail();
  if (key === "u") return kbUpdate();
  if (key === "U") return kbUpgrade();
  if (key === "p") return kbProtect();
  if (key === "f") return kbFixCI();
  if (key === "R") return kbRollup();
  if (key === "c") return kbReviewComments();
  if (key === "m") return kbReadyForReview();
  if (key === "M") return kbMergePR();
  if (key === "a") return kbRequestReview();
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
function kbRollup() { const r = cursorRepo(); if (r) onRollup(r); }
// A repo can have several PRs (each with its own Review button), so the shortcut opens the
// review console for the FIRST PR with unresolved comments on the cursor repo — the common
// case is a single such PR. For a specific other PR, click its 💬 Review button.
function kbReviewComments() {
  const r = cursorRepo();
  if (!r) return;
  const pr = (r.openPRs || []).find((p) => (p.reviewUnresolved || 0) > 0);
  if (!pr) { toast("No unresolved review comments on this repo."); return; }
  openReviewPanel(r, pr.number);
}
// Per-PR actions over the keyboard act on the FIRST eligible PR on the cursor repo (a card
// can hold several). For a specific other PR, click its button. Find the real button so the
// handler can disable it; fall back to a minimal stub carrying the data it reads.
function kbReadyForReview() {
  const r = cursorRepo();
  if (!r) return;
  const pr = (r.openPRs || []).find((p) => p.draft);
  if (!pr) { toast("No draft PR on this repo to mark ready."); return; }
  const btn = (cardEl(r.name) || document).querySelector(`.act-ready-pr[data-number="${pr.number}"]`) || { dataset: { number: String(pr.number) } };
  onReadyForReview(r, btn);
}
// Merge the cursor repo's first APPROVED PR that nothing is blocking. When every approved PR
// is blocked, say why for the first of them — a silent no-op would read as a broken key, and
// the reason (conflicts, a stack, protection) is the same text its disabled button carries.
function kbMergePR() {
  const r = cursorRepo();
  if (!r) return;
  const approved = (r.openPRs || []).filter((p) => p.reviewDecision === "APPROVED");
  if (!approved.length) { toast("No approved PR on this repo to merge."); return; }
  const pr = approved.find((p) => !mergeBlockedReason(p, r));
  if (!pr) { toast(`#${approved[0].number}: ${mergeBlockedReason(approved[0], r)}`); return; }
  const btn = (cardEl(r.name) || document).querySelector(`.act-merge-pr[data-number="${pr.number}"]`) || { dataset: { number: String(pr.number) } };
  onMergePR(r, btn);
}
function kbRequestReview() {
  const r = cursorRepo();
  if (!r) return;
  const sr = r.suggestedReviewer;
  if (!sr) { toast("No suggested reviewer for this repo yet."); return; }
  const pr = (r.openPRs || []).find((p) => !p.draft && p.reviewDecision !== "APPROVED" && !(p.reviewers || []).map(String).includes(sr.display));
  if (!pr) { toast("No PR here is ready for a review request."); return; }
  const btn = (cardEl(r.name) || document).querySelector(`.act-request-review[data-number="${pr.number}"]`) || { dataset: { number: String(pr.number), reviewer: sr.handle } };
  onRequestReview(r, btn);
}
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
  // Reads the inventory, not the alert model — it's the list that has every repo, alerted
  // or not. On the Untriaged tab it can still be mid-load.
  if (!STATE.complianceData) { toast("The org inventory is still loading…"); return; }
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
      syncModelClassification(name, toState);
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
  const onUntriaged = STATE.tab === "untriaged";
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
      // Untriaged rebinds m to Maintain and adds w/i, so it can't advertise
      // "mark ready for review" — see navAction / tabActionKeys.
      [onUntriaged ? k("m") + " / " + k("w") + " / " + k("i") : "", onUntriaged ? "Track as Maintain / Monitor / Ignore (selected, or cursor row)" : ""],
      [k("u"), "open an update PR / re-run"],
      [k("U"), "propose a runtime upgrade (EOL)"],
      [k("R"), "roll up ready PRs into one release PR"],
      [k("c"), "review comments (first PR with feedback)"],
      [onUntriaged ? "" : k("m"), onUntriaged ? "" : "mark a draft PR ready for review"],
      [k("M"), "merge an approved PR (first mergeable one)"],
      [k("a"), "assign / request review (first eligible PR)"],
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
  if (STATE.tab === "compliance") return "e#rpmwi";
  // Untriaged adds the Track-as keys (w/i) and rebinds m to Maintain — see navAction.
  if (STATE.tab === "untriaged") return "e#rupfURcamwiM";
  return "e#rupfURcmaM";
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

// Set a repo's engagement classification (Track as) from the inventory — the Compliance
// tab's <select>, or an alert-free row on the Untriaged tab — then refresh so the derived
// bits (protection scope/status) catch up with the new engagement.
async function onComplianceClassify(repo, stateWanted) {
  const r = STATE.complianceData.repos.find((x) => x.name === repo);
  const from = (r && r.classification) || "untriaged";
  const to = stateWanted || "untriaged";
  if (from === to) return;
  const meta = await engagementNoteModal({ subject: repo, from, to });
  // Cancelled → the Compliance tab has to re-render to reset its <select>; the Untriaged
  // tab's buttons hold no state, and repainting it from here would draw the compliance
  // table into the wrong tab.
  if (!meta) { if (STATE.tab === "compliance") drawCompliance(); return; }
  setRowsBusy([repo]);
  try {
    const data = await postJSON("/api/classify", { repo, state: stateWanted, note: meta.note, sowEndDate: meta.sowEndDate });
    syncModelClassification(repo, data.state);
    toast(`${repo} tracked as ${engagementLabel(data.state)}.`);
    loadComplianceData(); // re-derive scope/protection with the new classification (clears busy on re-render)
  } catch (e) {
    clearRowBusy();
    alert("Couldn't classify: " + e.message);
  }
}

// A repo can sit in BOTH the inventory and the alert model. Classifying it from the
// inventory has to update the model's copy too, or the alert tabs keep bucketing it by the
// old engagement until the next Refresh.
function syncModelClassification(repo, stateApplied) {
  const mr = STATE.model && STATE.model.repos.find((x) => x.name === repo);
  if (mr) mr.classification = stateApplied || "untriaged";
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
  // Dependabot isn't producing updates here — so "0 alerts" may mean unscanned, not clean.
  let db = "";
  if (r.dependabot && r.dependabot.state === "blocked") {
    db = ` <span class="db-blocked" title="Dependabot can't clone ${esc((r.dependabot.blockedBy || []).join(", "))}, which this repo depends on from git. Resolution fails, so EVERY dependency update here is silently skipped — security updates too. Grant Dependabot read access to that repo to fix it.">⚠ dependabot blocked</span>`;
  } else if (r.dependabot && r.dependabot.state === "stale") {
    const detail = (r.dependabot.stale || [])
      .map((s) =>
        `${s.ecosystem}: ${s.ageDays == null ? "never run" : `last ran ${s.ageDays}d ago`} (scheduled ${s.interval})` +
        (s.atLimit ? ` — ${s.openPRs} open PRs, AT the limit of ${s.prLimit}` : ""))
      .join("\n");
    db = ` <span class="db-stale" title="Configured but not running:\n${esc(detail)}\n\nNo error — Dependabot has simply gone quiet. Usually open-pull-requests-limit is reached, or GitHub paused the schedule.">⏱ dependabot idle</span>`;
  }
  // reverse dependency: other org repos that depend on this one
  const deps = (r.dependents || []).length
    ? ` <span class="dep-tag" title="Depended on by: ${esc((r.dependents || []).join(", "))}">↩ used by ${r.dependents.length} repo${r.dependents.length > 1 ? "s" : ""}</span>`
    : "";
  // Branch protection is only tracked for repos we maintain (classification maintained,
  // or pending = maintained in-flight). Everything else shows "—" (not applicable).
  let prot = "<span class='muted' title='Branch protection is only enforced on maintained repos'>—</span>";
  if (r.protectionScope) {
    if (r.protected === true) prot = `<button class="prot-lock" title="Protected by the SOC 2 ruleset — click to remove it (rare; reversible by re-protecting)">🔒 protected</button>`;
    else if (r.protected === false) prot = `<button class="prot-open" title="Unprotected — click to apply the SOC 2 ruleset (reviewed PR · no force-push · no deletion)">🔓 unprotected</button>`;
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
    `<td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="vis">${esc(r.visibility)}</span>${typeBadge}${deps}${dormant}${db}</td>` +
    `<td class="muted">${esc(push)}</td>` +
    `<td class="track-cell">${track}${engBadge}</td>` +
    `<td>${prot}</td>` +
    `<td>${toggle}</td>` +
    `<td class="prune-cell"><button class="row-archive subtle" title="Archive on GitHub (read-only, reversible)">Archive</button> <button class="row-delete danger" title="Permanently delete this repo on GitHub — irreversible">🗑</button></td>` +
    `</tr>`
  );
}

// Remove OUR SOC 2 ruleset from a protected repo (the rare undo of Protect). The
// server refuses protection this tool didn't create; the branch may stay protected
// by classic protection or a foreign ruleset, and the row reflects whatever remains.
async function onRowUnprotect(repo, btn) {
  const ok = await confirmModal({
    danger: true,
    confirmLabel: "Remove protection",
    message:
      `Remove the SOC 2 branch-protection ruleset from ${repo}?\n\n` +
      `Its default branch becomes mergeable without a reviewed PR, and force-pushes/deletion are no longer blocked — weakening a SOC 2 change-management control. ` +
      `Reversible anytime with Protect.`,
  });
  if (!ok) return;
  const restore = btnBusy(btn, '<span class="spin"></span>…');
  setRowsBusy([repo]);
  try {
    const data = await postJSON("/api/unprotect-branch", { repo });
    const r = STATE.complianceData.repos.find((x) => x.name === repo);
    if (r) r.protected = data.stillProtected;
    recomputeComplianceSummary();
    drawCompliance();
    toast(
      data.stillProtected
        ? `${repo}: removed our ruleset — still protected via ${data.via === "classic" ? "classic branch protection" : "another ruleset"}.`
        : `${repo}: branch protection removed.`
    );
  } catch (e) {
    clearRowBusy();
    alert("Couldn't remove protection: " + e.message);
    restore();
  }
}

async function onRowProtect(repo, btn) {
  const row = STATE.complianceData.repos.find((x) => x.name === repo);
  const branch = (row && row.defaultBranch) || "the default branch";
  const ok = await confirmModal({
    confirmLabel: "Protect branch",
    message:
      `Apply the SOC 2 branch-protection ruleset to ${repo}?\n\n` +
      `Merging into ${branch} will require a pull request with 1 approval; stale approvals are dismissed on new pushes, ` +
      `conversations must be resolved, and force-pushes & branch deletion are blocked. No one bypasses.\n\n` +
      `Reversible anytime by clicking the 🔒 badge (or from the repo's Settings → Rules).`,
  });
  if (!ok) return;
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
    // Keep in step with the server's summary (server.js /api/compliance) — this runs after
    // a local mutation (archive/delete), and a dropped key would hide the warning banner.
    dependabotBlocked: reps.filter((r) => r.dependabot && r.dependabot.state === "blocked").length,
    dependabotStale: reps.filter((r) => r.dependabot && r.dependabot.state === "stale").length,
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
  flushReviewerEdits(); // the reviewer picker batches its changes until it closes
  document.querySelectorAll(".dd-menu:not([hidden])").forEach((m) => (m.hidden = true));
}

// The reviewer picker is an editor, not a menu of actions: ticking and unticking names
// only changes local state, and the whole diff is sent as ONE `gh pr edit` when the menu
// closes. Applying per click would fire a request for every keystroke-equivalent — and
// worse, an accidental untick would immediately un-request someone with no chance to undo
// it before the menu shut. RR_EDIT holds the open picker's state; only one menu is ever
// open (closeAllMenus is the single choke point), so a single slot is enough.
let RR_EDIT = null;

function beginReviewerEdit(repo, menu) {
  const current = new Set(
    [...menu.querySelectorAll(".rr-opt.on")].map((b) => b.dataset.reviewer)
  );
  RR_EDIT = { repo, number: Number(menu.dataset.number), menu, original: new Set(current), current };
}

// Send the accumulated diff. Called from closeAllMenus, so every close path — the caret,
// clicking outside, opening another menu — applies rather than silently discarding.
function flushReviewerEdits() {
  const ed = RR_EDIT;
  RR_EDIT = null;
  if (!ed) return;
  const add = [...ed.current].filter((h) => !ed.original.has(h));
  const remove = [...ed.original].filter((h) => !ed.current.has(h));
  if (!add.length && !remove.length) return;
  const r = (STATE.model.repos || []).find((x) => x.name === ed.repo);
  if (!r) return;
  const pr = (r.openPRs || []).find((p) => p.number === ed.number);
  const chip = ed.menu.closest(".rr-dd") && ed.menu.closest(".rr-dd").querySelector(".rr-chip");
  if (chip) { chip.disabled = true; chip.textContent = "Saving…"; }

  // Apply the diff locally and repaint NOW rather than waiting on the round trip. We know
  // exactly what we're asking for, and waiting for the response left the 👀 badge showing
  // a reviewer that had already been removed: the server answers `reviewers: null` whenever
  // the PR isn't in its model cache, and the old code's `data.reviewers || pr.reviewers`
  // then quietly kept the stale list until a full page reload.
  const display = (h) => String(h).split("/").pop();
  const before = pr ? (pr.reviewers || []).slice() : null;
  const beforeDecision = pr ? pr.reviewDecision : null;
  const applyLocal = (list) => {
    if (!pr) return;
    pr.reviewers = list;
    // Clear the decision when nobody is left, or the next poll re-renders a review badge
    // for a PR that no longer has a reviewer.
    if (!pr.reviewers.length) pr.reviewDecision = null;
    else if (!pr.reviewDecision) pr.reviewDecision = "REVIEW_REQUIRED";
    // The CI poll overwrites reviewers from a live GitHub read every 10s. GitHub's read
    // side can still be serving the pre-edit set, which would flip the badge back moments
    // after we fixed it — so hold the poll off this PR's reviewers briefly.
    pr._reviewersEditedAt = Date.now();
  };
  const gone = new Set(remove.map(display));
  applyLocal([...new Set([...(before || []).filter((x) => !gone.has(x)), ...add.map(display)])]);
  scheduleRender();

  postJSON("/api/request-review", { repo: ed.repo, number: ed.number, add, remove })
    .then((data) => {
      // Only trust an actual array — `null` means the server couldn't confirm, and our
      // optimistic state is the better guess.
      if (Array.isArray(data.reviewers)) { applyLocal(data.reviewers); scheduleRender(); }
    })
    .catch((e) => {
      if (pr) { pr.reviewers = before; pr.reviewDecision = beforeDecision; } // put it back
      scheduleRender();
      alert("Couldn't update reviewers: " + e.message);
    });
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

// Renders the bump type as a small badge; major/minor stand out, a forced major
// (no same-major security fix) is flagged red so you can eyeball the breaking ones.
function bumpCell(p) {
  const b = p.bump || "";
  if (!b) return "—";
  if (p.majorRequired) return `<span class="bump major req" title="No same-major security fix — a major upgrade is required. Opt in manually.">major ⚠</span>`;
  if (b === "major" || b === "minor") return `<span class="bump ${b}">${b}</span>`;
  return `<span class="bump patch">patch</span>`;
}

// An advisory whose installed version already meets/exceeds its patched floor is already
// satisfied here (a no-op or a stale alert), not outstanding work — so it's shown muted with
// "✓ patched" instead of a misleading backwards "→ floor" arrow. (Lenient compare matching the
// rest of the tool; majorRequired stays outstanding since its target is a higher major.)
function advisorySatisfied(p) {
  const to = p.target || p.patched;
  return !!(p.installed && to && !verGt(to, p.installed)); // installed >= to
}

function pkgTable(pkgs) {
  // Outstanding first, then satisfied (muted) — so the rows that actually need action lead.
  const ordered = pkgs.slice().sort((a, b) => (advisorySatisfied(a) ? 1 : 0) - (advisorySatisfied(b) ? 1 : 0));
  const rows = ordered
    .map((p) => {
      const to = p.target || p.patched;
      const done = advisorySatisfied(p);
      const toCell = done
        ? `<span class="muted" title="installed ${esc(p.installed || "?")} already ≥ patched floor ${esc(to || "?")}">✓ patched</span>`
        : (to ? "→ " + esc(to) : "—");
      return `<tr${done ? ' class="pkg-satisfied"' : ""}>
        <td><span class="sev-dot ${esc(p.severity)}"></span>${esc(p.severity)}</td>
        <td>${esc(p.ecosystem)}</td>
        <td><code>${esc(p.pkg)}</code></td>
        <td class="ver-from">${p.installed ? esc(p.installed) : "—"}</td>
        <td class="ver-to">${toCell}</td>
        <td>${done ? "—" : bumpCell(p)}</td>
        <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.ghsa || "view")}</a>` : esc(p.ghsa || "")}</td>
      </tr>`;
    })
    .join("");
  return `<table class="pkgs">
      <thead><tr><th>Sev</th><th>Ecosystem</th><th>Package</th><th>From</th><th>To</th><th>Bump</th><th>Advisory</th></tr></thead>
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
      <button class="menu-sessions">🗒 Session log</button>
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
// labClass "flow" switches the label from the default inline-flex (text + a trailing
// badge on one baseline) to normal block flow — needed for long paragraph labels that
// contain inline <code>, which inline-flex would split into gapped flex items.
function srow(kind, labHtml, right = "", meta = "", labClass = "") {
  const r = (meta ? `<span class="srow-meta">${meta}</span>` : "") + (right || "");
  return (
    `<div class="srow ${kind}"><span class="lab ${kind}${labClass ? " " + labClass : ""}">${labHtml}</span>` +
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
  pending: "Update PRs whose CI is still running, failing, or being fixed (live fix logs on each card).",
  passing: "Update PRs with green CI but no approval yet — awaiting review.",
  approved: "Update PRs that are approved — ready to merge.",
  monitored: "Inactive-client repos you watch but don't patch — email the client, then mark them notified.",
  notified: "Monitored repos whose client has already been emailed about these vulnerabilities.",
  ignored: "Repos that are out of scope for this tool.",
  untriaged: "Every org repo you haven't classified yet, alerts or not — mark each Maintain, Monitor, or Ignore.",
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
  const db = dependabotMeta(r);
  if (db) segs.push(db);
  return segs;
}

// Open Dependabot version-update PRs — routine bumps with no advisory behind them, which
// this tool deliberately never acts on. It's a LINK and a count, never a button: the whole
// point of the scope line is that merging arbitrary majors stays a human decision.
//
// Leads with the application-dependency count rather than the total, because github_actions
// bumps are CI plumbing and rarely the thing that hurts; falling many majors behind on an
// app dependency is how a future security patch ends up unappliable. Majors and failures are
// called out for the same reason — they're the ones that rot rather than the ones that queue.
function dependabotMeta(r) {
  const d = r.dependabotPRs;
  if (!d || !d.total) return "";
  const org = (STATE.model && STATE.model.org) || "";
  const url = `https://github.com/${org}/${r.name}/pulls?q=${encodeURIComponent("is:pr is:open author:app/dependabot")}`;
  const bits = [];
  if (d.app) bits.push(`${d.app} app`);
  if (d.infra) bits.push(`${d.infra} ci`);
  if (d.major) bits.push(`<strong class="db-major">${d.major} major</strong>`);
  if (d.failing) bits.push(`<strong class="db-failing">${d.failing} failing</strong>`);
  // The tooltip carries the detail the meta line can't: what, and how far behind.
  const lines = d.prs
    .slice(0, 12)
    .map((p) => `#${p.number} ${p.pkg || p.title}${p.from ? ` ${p.from} → ${p.to}` : ""}${p.bump === "major" ? " (major)" : ""}${p.failing ? " ✗" : ""}`);
  if (d.prs.length > 12) lines.push(`…and ${d.prs.length - 12} more`);
  const age = d.oldestAt ? `\n\nOldest opened ${relTime(d.oldestAt)}.` : "";
  return (
    `<a class="dep-meta db-prs" href="${esc(url)}" target="_blank" rel="noopener" ` +
    `title="Open Dependabot version-update PRs — routine bumps with no advisory, so this tool leaves them to you:\n${esc(lines.join("\n"))}${esc(age)}">` +
    `🤖 ${d.total} Dependabot${bits.length ? ` · ${bits.join(" · ")}` : ""}</a>`
  );
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
// The PR (number) this one is stacked on, derived from the LIVE base chain: its base branch
// is another open PR's head branch. Ground truth from GitHub — catches any stack (ours, or a
// human's) and survives pr-links.json drift, since the retargeted base is the real signal.
function stackParentNumber(pr, r) {
  const base = pr.baseRefName;
  if (!base) return null;
  const parent = (r.openPRs || []).find((p) => p.number !== pr.number && p.headRefName === base);
  return parent ? parent.number : null;
}
// A consolidation badge: this PR is stacked on / sequenced after another. Stacking is read
// from the live base chain (authoritative); sequence ordering (which doesn't change the base)
// from the recorded pr-links. Surfaces the relationship in the dashboard — otherwise it only
// lives in the GitHub PR comments.
function linkBadge(pr, r) {
  const parent = stackParentNumber(pr, r);
  if (parent) return ` <span class="rev-state stacked" title="Stacked on #${parent} — its base is that PR's branch, so this shows only its own delta; merge #${parent} first">🥞 stacked on #${parent}</span>`;
  const l = pr.link;
  if (!l || !l.blockedBy) return "";
  // Fallback: a stack whose base retarget didn't land, or a recorded sequence ordering.
  if (l.strategy === "stack") return ` <span class="rev-state stacked" title="Stacked on #${l.blockedBy} — merge that first; this shows only its own delta">🥞 stacked on #${l.blockedBy}</span>`;
  return ` <span class="rev-state sequenced" title="Sequenced after #${l.blockedBy} — auto-rebases when #${l.blockedBy} merges">⏱ after #${l.blockedBy}</span>`;
}
// One PR per row: link + review status + the CI check state, all consolidated onto a
// single line (the CI used to be its own row). A failing PR's "Fix CI" button rides in
// the right slot next to Copy.
// Per-PR check-state label, from the per-PR status pollCI attaches. Each open PR has its
// own check run, so every chip shows its own badge — not just the repo's worst on chip 0.
function ciLabel(ci) {
  if (!ci || !ci.state) return "";
  const fails = (ci.failing || []).length;
  const labels = {
    passing: "✓ checks passing",
    failing: `✗ ${fails} check${fails === 1 ? "" : "s"} failing`,
    pending: "⏳ checks running",
    none: "— no checks",
  };
  if (!labels[ci.state]) return "";
  const cls = { passing: "ok", failing: "danger", pending: "warn", none: "muted" }[ci.state] || "muted";
  const t = fails ? ` title="${esc(ci.failing.join(", "))}"` : "";
  return `<span class="ci-inline ${cls}"${t}>${labels[ci.state]}</span>`;
}

// A PR is rollup-eligible when its CI isn't red (or still running) and it isn't a draft or
// flagged changes-requested — i.e. work that's ready to ship. Passing CI qualifies, and so
// does a PR with NO checks at all ("none") — only FAILING or in-flight checks disqualify.
// Review isn't required: the rollup PR itself is review-gated before merge, so consolidating
// unreviewed-but-ready work is safe and lets the whole stack be reviewed once, on the
// combined PR. (`unknown`/unpolled state stays out — we only roll up a definite signal.)
function rollupEligible(pr) {
  if (!pr || pr.draft) return false;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return false;
  const ci = pr.ci && pr.ci.state;
  return ci === "passing" || ci === "none";
}

// A PR is a consolidation candidate when it's not a draft, not changes-requested, and isn't
// itself a release rollup — CI state is irrelevant here (the collision is between branches,
// not checks), which is why this fires on the Pending tab too, unlike rollupEligible.
function consolidationCandidate(pr) {
  if (!pr || pr.draft) return false;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return false;
  if (pr.link && pr.link.blockedBy) return false; // already stacked/sequenced — don't re-offer
  return !String(pr.headRefName || "").startsWith("release/deps-");
}

// The largest set of this repo's open PRs that WILL collide on merge: ≥2 candidates sharing
// a base branch AND a lockfile basename (the surface that actually conflicts). Mirrors the
// server's computeConsolidationCluster so the banner only appears when there's a real clash.
// Returns { base, lock, prs:[…] } or null. Degrades to null on an older model that predates
// baseRefName/lockfiles (no false positives).
function consolidationCluster(r) {
  const cands = (r.openPRs || []).filter(consolidationCandidate);
  const buckets = new Map();
  for (const pr of cands) {
    const base = pr.baseRefName || r.defaultBranch || "main";
    for (const lock of pr.lockfiles || []) {
      const key = base + "\n" + lock;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(pr);
    }
  }
  let best = null;
  for (const [key, prs] of buckets) {
    const uniq = [...new Map(prs.map((p) => [p.number, p])).values()];
    if (uniq.length >= 2 && (!best || uniq.length > best.prs.length)) {
      const [base, lock] = key.split("\n");
      best = { base, lock, prs: uniq };
    }
  }
  return best;
}

// When ≥2 of a repo's PRs branched off the same base and both change the same lockfile, they
// can't all merge cleanly — the second invalidates the first's lockfile. Offer the three ways
// out (the user picks per repo): roll up into ONE PR, STACK them so they merge in order, or
// SEQUENCE them (independent PRs that auto-rebase as each blocker merges). Shown on every
// PR-lifecycle tab. Falls back to the legacy rollup-only banner when the model lacks the
// base/lockfile data needed to detect a precise cluster.
function consolidationBanner(r) {
  if (!PR_TABS.has(STATE.tab)) return "";
  const cl = consolidationCluster(r);
  if (cl) {
    const n = cl.prs.length;
    const nums = cl.prs.map((p) => `#${p.number}`).join(", ");
    const base = esc(cl.base), lock = esc(cl.lock);
    // Always recommend Roll up for a cluster. A cluster is, by definition, PRs that collide on
    // the lockfile, so they WILL conflict on merge — which means sequencing or stacking still
    // rebases (and, on a protected repo, dismisses the approval of) every PR after the first.
    // So "they're approved → sequence to keep approvals" doesn't hold: only the front PR's
    // approval survives. Rolling up resolves the conflict once and needs a single review.
    // Sequence/Stack stay available for when you deliberately want N PRs (e.g. you expect them
    // NOT to actually conflict, or you want to merge incrementally), but aren't auto-recommended.
    const rec = "rollup";
    const recWhy = "recommended: these PRs collide on the lockfile, so they conflict on merge — sequencing or stacking would rebase (and dismiss approvals on) every PR after the first, while rolling up resolves it once and needs a single review";
    const tag = (k) => (rec === k ? ` <span class="rec-chip" title="${recWhy}">recommended</span>` : "");
    const cls = (k) => (rec === k ? "primary " : "");
    const rollupBtn = `<button class="${cls("rollup")}act-rollup" title="ONE PR: a high-effort session merges ALL ready dependency PRs on this base (every lockfile, not just ${lock}) onto a new release/deps branch, regenerates the lockfiles once, opens a single PR to review &amp; squash-merge, and closes the originals. You set the order next.">⬆ Roll up → 1 PR${tag("rollup")}</button>`;
    const stackBtn = `<button class="${cls("stack")}act-stack" title="${n} ORDERED PRs: a session merges each PR onto the one below it and regenerates ${lock}, then retargets each PR's base so it shows only its own change and merges cleanly bottom-up. Keeps every PR reviewable on its own.">🥞 Stack → ${n} ordered PRs${tag("stack")}</button>`;
    const seqBtn = `<button class="${cls("sequence")}act-sequence" title="${n} INDEPENDENT PRs: no code changes now — records a merge order and comments it on each PR. When a blocker merges, the dashboard auto-rebases the next one (merge base + regenerate ${lock}). Lightest touch; resolves the clash lazily at merge time.">⏱ Sequence → merge in order${tag("sequence")}</button>`;
    return srow(
      "warn",
      `🧬 ${n} PRs (${nums}) on <code>${base}</code> both change <code>${lock}</code> — they'll conflict on merge. Consolidate:`,
      rollupBtn + " " + stackBtn + " " + seqBtn,
      "",
      "flow"
    );
  }
  // Fallback: legacy rollup-only banner for an older model without base/lockfile data, on the
  // shippable tabs where it always lived (≥2 ready PRs, no precise collision check available).
  if (STATE.tab !== "approved" && STATE.tab !== "passing") return "";
  const eligible = (r.openPRs || []).filter(rollupEligible);
  if (eligible.length < 2) return "";
  const btn = `<button class="primary act-rollup" title="Merge these ${eligible.length} PRs onto one release branch via a high-effort Claude session (conflicts + lockfiles resolved once), open a single release PR to review &amp; squash-merge, and close the originals in its favor">⬆ Roll up ${eligible.length} PRs into one release PR</button>`;
  return srow(
    "info",
    `🧬 ${eligible.length} PRs without failing checks touch the same lockfiles — consolidate into one coherent release PR so conflicts &amp; lockfiles resolve once, then review &amp; squash-merge.`,
    btn,
    "",
    "flow"
  );
}

// Why an approved PR can't be merged right now, or null when it can. GitHub's
// mergeStateStatus is the authority: DIRTY = conflicts with the base, BEHIND = the base moved
// and the repo requires branches to be up to date, BLOCKED = branch protection isn't
// satisfied yet (a required check, an unresolved conversation, another approval).
// CLEAN / HAS_HOOKS / UNSTABLE all merge. An UNKNOWN or absent status (GitHub hasn't computed
// it yet, or a server too old to poll it) is NOT treated as blocked — the attempt goes through
// and GitHub's own answer is what the user sees.
// PRs this tool did NOT open that will collide with ours on merge — same base, same lockfile
// (flagged in the model by annotateForeignCollisions, which sees every open PR, not just ours).
// Report-only, deliberately: the consolidation banner's three actions all close, rewrite, or
// comment on the PRs they touch, and none of that may reach a PR somebody else owns. So this
// names the clash, links it, and leaves the call to the human — who can talk to the author, or
// just let whoever merges second hit ⟳ Update branch.
function foreignCollisionRows(r) {
  if (!PR_TABS.has(STATE.tab)) return "";
  // Scope to the PRs this tab is showing, like prChips — a warning about a PR that isn't on
  // screen reads as belonging to one that is.
  const mine = (r.openPRs || []).filter(
    (p) => (p.collidesWith || []).length && prLifecycleState(p, r) === STATE.tab
  );
  if (!mine.length) return "";
  // One row per FOREIGN PR (not per pair): with several of ours hitting the same PR, the thing
  // to know is that #219 is in the way, once.
  const byForeign = new Map();
  for (const p of mine) {
    for (const f of p.collidesWith) {
      // Base comes from OUR PR in the pair: a collision is same-base by definition, so this is
      // the branch they're both racing for (mine[0]'s base would be a guess once a repo has
      // PRs on more than one base).
      if (!byForeign.has(f.number)) byForeign.set(f.number, { f, ours: [], base: p.baseRefName });
      byForeign.get(f.number).ours.push(p.number);
    }
  }
  // A long-lived repo can have several of these at once (crows-nest had two humans plus an
  // old Electron branch). Show the newest few and count the rest — a wall of amber rows above
  // the PR is worse than no warning, because it stops being read.
  const all = [...byForeign.values()].sort((a, b) => b.f.number - a.f.number);
  const shown = all.slice(0, 3);
  const more = all.length - shown.length;
  return shown
    .map(({ f, ours, base: sharedBase }) => {
      const who = f.author ? ` by <strong>@${esc(f.author)}</strong>` : "";
      const locks = f.lockfiles.map((l) => `<code>${esc(l)}</code>`).join(", ");
      const base = sharedBase || r.defaultBranch || "the base";
      const link = `<a class="eol-pr-link" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.title)}">#${f.number} →</a>`;
      return srow(
        "warn",
        `⚠ PR #${f.number}${who}${f.draft ? " <span class=\"pr-meta\">(draft)</span>" : ""} also changes ${locks} on <code>${esc(base)}</code> — ` +
          `this tool didn't open it, so consolidation can't include it. Whichever of #${f.number} / ${ours.map((n) => "#" + n).join(", ")} merges second needs ⟳ Update branch.`,
        link
      );
    })
    .join("") +
    (more
      ? srow("warn", `⚠ …and ${more} more open PR${more === 1 ? "" : "s"} on this base ${more === 1 ? "changes" : "change"} a lockfile this one also changes.`)
      : "");
}

// Open PRs stacked ON this one (their base is its head branch) — the inverse of
// stackParentNumber. Only sees this tool's PRs, so it's for the heads-up in the confirm
// dialog; the server re-asks GitHub (which also sees human PRs) before choosing how to merge.
function stackChildNumbers(pr, r) {
  const head = pr.headRefName;
  if (!head) return [];
  return (r.openPRs || []).filter((p) => p.number !== pr.number && p.baseRefName === head).map((p) => p.number);
}

function mergeBlockedReason(pr, r) {
  if (pr.draft) return "This PR is still a draft — mark it ready for review first.";
  const parent = stackParentNumber(pr, r);
  if (parent) return `Stacked on #${parent} — this targets that PR's branch, so merging it now wouldn't reach the base. Merge #${parent} first; GitHub then retargets this one.`;
  if (pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING") return "This branch conflicts with its base — resolve it with ⟳ Rebase & resolve first.";
  if (pr.mergeStateStatus === "BEHIND") return "This branch is behind its base and the repo requires branches to be up to date — use ⟳ Update branch first.";
  if (pr.mergeStateStatus === "BLOCKED") {
    const n = pr.reviewUnresolved || 0;
    return n > 0
      ? `GitHub is blocking the merge — ${n} unresolved review comment${n === 1 ? "" : "s"}. Clear ${n === 1 ? "it" : "them"} with 💬 Review.`
      : "GitHub is blocking the merge — a required check or review isn't satisfied yet. Open the PR to see which.";
  }
  return null;
}

function prChips(r) {
  if (!r.openPRs || !r.openPRs.length) return "";
  // On a PR-lifecycle tab, show only this repo's PRs in that state — the per-PR split. The
  // same repo can appear in several tabs, each card scoped to its matching PRs. Off those
  // tabs (shouldn't happen for a pending repo, but be safe), show all. Ascending by number
  // (oldest first) so the list reads in the same direction as the FIFO merge order.
  const prs = (PR_TABS.has(STATE.tab)
    ? r.openPRs.filter((pr) => prLifecycleState(pr, r) === STATE.tab)
    : r.openPRs.slice()
  ).slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  if (!prs.length) return "";
  const ci = ciInline(r); // repo-level — supplies the Fix CI button (+ the legacy fallback)
  // New servers attach per-PR status (pr.ci); older ones don't. Fall back to the repo-level
  // badge on the first chip so a browser-reload-before-server-restart doesn't lose all badges.
  const havePerPr = prs.some((pr) => pr.ci && pr.ci.state);
  let btnShown = false; // one fix job per repo → attach its button to the first failing PR
  return prs
    .map((pr, i) => {
      const label = havePerPr ? ciLabel(pr.ci) : (i === 0 ? ci.text : "");
      const ciText = label ? ` <span class="pr-meta">·</span> ${label}` : "";
      let fixBtn = "";
      const isFailing = havePerPr ? !!(pr.ci && pr.ci.state === "failing") : i === 0;
      if (!btnShown && isFailing && ci.btn) { fixBtn = ci.btn; btnShown = true; }
      // One-click "request review from the person you usually ask" (derived server-side
      // from the most recent PR, open or closed). Only on a NON-draft PR: GitHub doesn't
      // notify requested reviewers while a PR is a draft, so gate it behind the draft→ready
      // flip below — request a review only once the PR is actually ready for one.
      const rc = reviewerChoices(r, pr);
      // Shown whenever there's anyone to pick from — not just anyone left to ADD. Gating on
      // rc.def would hide the control once everyone is requested, which is exactly when you
      // need it to remove someone. The chip then falls back to the first name, disabled.
      const rcLead = rc.def || rc.opts[0];
      const reviewBtn = rcLead && !pr.draft && pr.reviewDecision !== "APPROVED"
        ? `<span class="pr-act rr">` +
          `<span class="rr-label">👤 Request review from</span>` +
          `<span class="dd rr-dd">` +
          (rc.def
            ? `<button class="rr-chip act-request-review" data-number="${pr.number}" data-reviewer="${esc(rc.def.handle)}" title="Request a review from @${esc(rc.def.display)} on this PR">@${esc(rc.def.display)}</button>`
            : `<button class="rr-chip" disabled title="Everyone here is already requested — use ▼ to remove someone">@${esc(rcLead.display)}</button>`) +
          `<button class="dd-trigger rr-caret" data-open title="Add or remove reviewers">▼</button>` +
          `<div class="dd-menu rr-menu" data-number="${pr.number}" hidden>` +
          `<div class="menu-section">${rc.fromHistory ? "Reviewed this repo" : `${esc(STATE.model.org || "org")} members`}</div>` +
          rc.opts
            .map(
              (o) =>
                `<button class="rr-opt${o.requested ? " on" : ""}" data-reviewer="${esc(o.handle)}" aria-pressed="${o.requested}" title="Click to ${o.requested ? "remove" : "request"} @${esc(o.display)} — applied when you close this menu">` +
                `<span class="rr-tick">${o.requested ? "✓" : ""}</span>` +
                `<span class="rr-who">@${esc(o.display)}</span>` +
                (o.isTeam ? `<span class="rr-hint">team</span>` : "") +
                `</button>`
            )
            .join("") +
          `<div class="rr-foot">Applied when this menu closes</div>` +
          `</div></span></span>`
        : "";
      const readyBtn = pr.draft
        ? `<button class="pr-act act-ready-pr" data-number="${pr.number}" title="Mark this draft PR as ready for review on GitHub">Mark ready for review</button>`
        : "";
      // Stale-branch action: a PR behind its base, or conflicting with it, needs the base
      // merged in + lockfiles regenerated. A headless Claude session handles either (a plain
      // update for BEHIND, full conflict resolution for DIRTY/CONFLICTING). Surfaces only
      // when the merge-state poll says it's needed, so it's absent on clean/up-to-date PRs.
      const conflicting = pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING";
      const behind = pr.mergeStateStatus === "BEHIND";
      const rebaseBtn = (conflicting || behind)
        ? `<button class="pr-act act-rebase" data-number="${pr.number}" title="${conflicting
            ? "This branch conflicts with the base — launch a headless Claude session to merge the base in, regenerate lockfiles, and resolve the conflicts"
            : "This branch is behind the base — merge the base in and regenerate lockfiles so it's mergeable again"}">⟳ ${conflicting ? "Rebase &amp; resolve" : "Update branch"}</button>`
        : "";
      // Unresolved review threads (Copilot + humans) → open the review console to triage,
      // address, and resolve them. Count comes from the per-PR poll (pr.reviewUnresolved).
      const rvN = pr.reviewUnresolved || 0;
      const reviewCommentsBtn = rvN > 0
        ? `<button class="pr-act act-review-comments" data-number="${pr.number}" title="${rvN} unresolved review comment${rvN === 1 ? "" : "s"} (Copilot + reviewers) — open the review console to triage, fix, reply &amp; resolve">💬 Review ${rvN}</button>`
        : "";
      // The finishing move, on an APPROVED PR only — the Approved tab's whole point. When
      // something stands in the way (conflicts, a stack, branch protection) the button stays
      // visible but disabled, saying what to do instead: a merge that GitHub would reject is
      // better refused here, with the fix named, than fired off to come back as an error.
      const mergeWhy = pr.reviewDecision === "APPROVED" ? mergeBlockedReason(pr, r) : null;
      const mergeBtn = pr.reviewDecision !== "APPROVED"
        ? ""
        : mergeWhy
          ? `<button class="pr-act merge" data-number="${pr.number}" disabled title="${esc(mergeWhy)}">🔀 Merge</button>`
          : `<button class="pr-act merge act-merge-pr" data-number="${pr.number}" title="Merge this approved PR into ${esc(pr.baseRefName || r.defaultBranch || "its base")} on GitHub — squash where the repo allows it, then clean up the branch">🔀 Merge</button>`;
      const right =
        fixBtn +
        rebaseBtn +
        reviewCommentsBtn +
        reviewBtn +
        readyBtn +
        mergeBtn +
        `<button class="copy-btn act-copy-pr" data-url="${esc(pr.url)}" data-label="${esc(r.nameWithOwner + "#" + pr.number)}" title="Copy linked PR reference">⧉ Copy</button>`;
      const title = (pr.title || "").trim();
      const titleHtml = title
        ? ` <span class="pr-title" title="${esc(title)}">${esc(title.length > 56 ? title.slice(0, 55) + "…" : title)}</span>`
        : "";
      return srow(
        "pr",
        `🔗 <a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}${pr.draft ? " · draft" : ""} →</a>${titleHtml}${reviewBadge(pr)}${linkBadge(pr, r)}${ciText}`,
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
    lsSet("ci.status", JSON.stringify(STATE.ciStatus)); // so next page load buckets PRs correctly on first paint
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
          // Skip reviewers (and the decision derived from them) for a few seconds after a
          // local edit: this comes from a live GitHub read that can still be serving the
          // pre-edit set, which would flip the badge back right after we changed it.
          const justEdited = pr._reviewersEditedAt && Date.now() - pr._reviewersEditedAt < 20000;
          if (m && !justEdited) { pr.reviewDecision = m.reviewDecision; pr.reviewers = m.reviewers; }
          if (m) { pr.draft = m.draft; pr.mergeable = m.mergeable; pr.mergeStateStatus = m.mergeStateStatus; pr.reviewUnresolved = m.reviewUnresolved || 0; pr.ci = m.ci; if (m.baseRefName != null) pr.baseRefName = m.baseRefName; if (m.lockfiles) pr.lockfiles = m.lockfiles; pr.link = m.link || null; }
        }
      }
    }
    const snap = JSON.stringify(STATE.ciStatus) + "|" + JSON.stringify(data.prMeta || {});
    if (snap !== STATE._ciSnap) {
      STATE._ciSnap = snap;
      // A fresh CI result or approval can move a repo between the PR-lifecycle tabs, so
    // refresh tabs+counts too, not just the current tab's cards. Use scheduleRender (not
    // render) so this poll-driven rebuild preserves the user's scroll position — a bare
    // render() here jumps the page on every CI/review change while you're on a PR tab.
    if (PR_TABS.has(STATE.tab) && STATE.model) scheduleRender(); // refresh on change (scroll-safe)
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
  const openPRs = r.openPRs || [];
  return findings
    .map((f) => {
      // If a runtime-upgrade PR for THIS runtime is already open, the upgrade is in
      // flight — show a link to it instead of inviting a duplicate "Propose upgrade".
      const pr = openPRs.find((p) => (p.headRefName || "").startsWith(`runtime-upgrade/${f.id}-`));
      const label = `⚠ ${esc(f.id)} <span class="ver">${esc(f.pinned)}</span> is end-of-life${f.eolDate ? ` · ${esc(String(f.eolDate).slice(0, 7))}` : ""} <span class="srow-arrow">→ <span class="ver">${esc(f.target.version)}</span>${f.target.lts ? " LTS" : ""}</span>`;
      const right = pr
        ? `<a class="eol-pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener" title="A runtime-upgrade PR for ${esc(f.id)} is already open — review and merge it">⬆ upgrade in PR #${esc(String(pr.number))} →</a>`
        : `<button class="eol-upgrade-btn" data-id="${esc(f.id)}" title="Open a runtime-upgrade PR: rewrites the pin + regenerates lockfiles under the new version">⬆ Propose upgrade</button>`;
      // Amber ("in progress") once a PR exists; red ("needs action") otherwise.
      return srow(pr ? "warn" : "danger", label, right);
    })
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

// Remediation buttons appear only on repos we actually patch (maintained, or pending =
// maintained with an in-flight PR) — never monitored/notified/ignored/untriaged.
function canRemediate(r) {
  return !r.archived && (r.classification === "maintained" || r.pending);
}

// A run left flagged advisories below their patched floor: a same-major fix exists
// but a Gemfile/package.json or parent-dependency constraint caps it. Distinct from a
// gem's "blocked" disposition (that's a gemspec the gem itself must bump). Renders a
// summary tick + an inline table with the full detail (mirrors the PR's Blocked table).
// Open PRs this tool opened for a given branch family (unblock / major-upgrade), so
// the card can show "PR already open" instead of inviting a duplicate run.
function openToolPRs(r, prefix) {
  return (r.openPRs || []).filter((p) => (p.headRefName || "").startsWith(prefix));
}

// Slugify exactly like lib/upgrader.js so a major package can be matched to its open
// major-upgrade PR branch (major-upgrade/<eco>-<pkg>-<target>-<date>).
const branchSlug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

// The deduped majors that DON'T yet have an open major-upgrade PR — i.e. what an
// "Upgrade majors" click would actually open. Matched by package (not the date-stamped
// branch), so an already-open major is excluded even on a later day.
function majorsNeedingPR(r, majors) {
  const open = openToolPRs(r, "major-upgrade/");
  return majors.filter((m) => !open.some((p) => p.headRefName.startsWith(`major-upgrade/${branchSlug(m.ecosystem)}-${branchSlug(m.pkg)}-`)));
}

function blockedAdvisories(r) {
  const list = r.blocked || [];
  if (!list.length) return "";
  const n = list.length;
  // An unblock PR is already in flight — link to it instead of offering to start another
  // (the server would skip the session anyway). Mirrors the EOL "upgrade in PR" pattern.
  const openPr = canRemediate(r) ? openToolPRs(r, "dependency-unblock/")[0] : null;
  const btn = !canRemediate(r)
    ? ""
    : openPr
      ? `<a class="eol-pr-link" href="${esc(openPr.url)}" target="_blank" rel="noopener" title="An unblock PR is already open — review and merge it">🔧 unblock in PR #${esc(String(openPr.number))} →</a>`
      : `<button class="primary act-unblock" title="Open a draft PR that raises the blocking manifest/parent constraints (high-effort Claude session), then let CI iterate">🔧 Try to unblock</button>`;
  const head = srow(
    "warn",
    `🚫 ${n} advisor${n === 1 ? "y" : "ies"} blocked by a manifest constraint — a same-major fix exists, but a ` +
      `Gemfile/<code>package.json</code> or parent-dependency range caps it. Bump the blocking constraint (or its parent), then re-run.`,
    btn,
    "",
    "flow"
  );
  const rows = list
    .map(
      (b) => `<tr>
        <td>${esc(b.ecosystem)}</td>
        <td><code>${esc(b.pkg)}</code></td>
        <td class="ver-from">${b.resolved ? esc(b.resolved) : "—"}</td>
        <td class="ver-to">→ ≥ ${esc(b.floor)}</td>
        <td class="blk-why">${esc(b.reason || "")}</td>
      </tr>`
    )
    .join("");
  const table =
    `<table class="pkgs blocked-table">` +
    `<thead><tr><th>Ecosystem</th><th>Package</th><th>Resolved</th><th>Needs</th><th>Why it's blocked</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  return head + table;
}

// Loose "a newer than b" for version strings (numeric segments; non-numeric → 0).
function verGt(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

// Collapse the major-required advisories to ONE entry per package — that's a single
// upgrade (one PR), even when several advisories flag it. Keep the highest required
// version and gather every advisory so the count + table match what we actually open.
// Mirrors lib/upgrader.js dedupeMajors.
function dedupeMajors(list) {
  const byPkg = new Map();
  for (const p of list || []) {
    const cur = byPkg.get(p.pkg);
    if (!cur) { byPkg.set(p.pkg, { ...p, advisories: p.ghsa ? [{ ghsa: p.ghsa, url: p.url }] : [] }); continue; }
    if (p.ghsa && !cur.advisories.some((a) => a.ghsa === p.ghsa)) cur.advisories.push({ ghsa: p.ghsa, url: p.url });
    if (verGt(p.target || p.patched || "0", cur.target || cur.patched || "0")) { cur.target = p.target; cur.patched = p.patched; }
  }
  return [...byPkg.values()];
}

// Advisories whose only fix crosses a major (no same-major patch). Held out of the
// lockfile-only PR and listed for a deliberate opt-in — mirrors the PR body's
// "Major upgrades required" table. Data comes from the per-package majorRequired flag
// the model already carries (no run needed), so it shows on every tab, not just Pending.
function majorRequiredAdvisories(r) {
  const raw = (r.packages || []).filter((p) => p.majorRequired);
  if (!raw.length) return "";
  // Count + list DISTINCT package upgrades (= one PR each), not raw advisories — a gem
  // flagged by two advisories is still one upgrade.
  const list = dedupeMajors(raw);
  const n = list.length;
  // Reflect how many major-upgrade PRs are already in flight: once every distinct major
  // has a PR, link instead of re-offering; while some remain, keep the button (it opens
  // PRs only for the missing ones) but note how many are open.
  const openPrs = canRemediate(r) ? openToolPRs(r, "major-upgrade/") : [];
  // Only the majors still missing a PR are what a click opens — label + count reflect that.
  const remaining = canRemediate(r) ? majorsNeedingPR(r, list) : list;
  const btn = !canRemediate(r)
    ? ""
    : remaining.length === 0
      ? `<a class="eol-pr-link" href="${esc(openPrs[0].url)}" target="_blank" rel="noopener" title="Major-upgrade PRs are open — review and merge them">⬆ ${openPrs.length} major PR${openPrs.length === 1 ? "" : "s"} open →</a>`
      : `<button class="primary act-upgrade-majors" title="Open one draft PR per remaining major upgrade (high-effort Claude sessions that update code/tests for the breaking changes), then let CI iterate">⬆ Upgrade ${remaining.length} major${remaining.length === 1 ? "" : "s"}${openPrs.length ? ` (${openPrs.length} open)` : ""}</button>`;
  const head = srow(
    "warn",
    `⚠ ${n} major upgrade${n === 1 ? "" : "s"} required — no same-major security fix, so ${n === 1 ? "it was" : "they were"} left out ` +
      `of the lockfile-only PR. A major bump is likely breaking; review and opt in deliberately.`,
    btn,
    "",
    "flow"
  );
  const rows = list
    .map((p) => {
      const to = p.target || p.patched || "?";
      const advs = (p.advisories && p.advisories.length ? p.advisories : (p.ghsa ? [{ ghsa: p.ghsa, url: p.url }] : []));
      const adv = advs
        .map((a) => (a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.ghsa)}</a>` : esc(a.ghsa || "")))
        .join(", ") || "—";
      return `<tr>
        <td>${esc(p.ecosystem)}</td>
        <td><code>${esc(p.pkg)}</code></td>
        <td class="ver-from">${p.installed ? esc(p.installed) : "—"}</td>
        <td class="ver-to">→ ${esc(to)}</td>
        <td>${adv}</td>
      </tr>`;
    })
    .join("");
  const table =
    `<table class="pkgs major-table">` +
    `<thead><tr><th>Ecosystem</th><th>Package</th><th>Current</th><th>Required</th><th>Advisory</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  return head + table;
}

// ---- card status list ---------------------------------------------------------
// One flat list, ordered by urgency: attention items (amber/red ticks, each with its
// action button), then the in-flight PR rows (blue), then resting notes (green/muted).
// The colored left tick per row replaces the old labeled zone boxes.
function statusRows(r) {
  // Blocked + major upgrades are uninitiated work, surfaced (and kicked off) in the
  // worklist tabs — not on the PR-lifecycle tabs, where the card is about in-flight PRs.
  const kickoff = PR_TABS.has(STATE.tab) ? "" : blockedAdvisories(r) + majorRequiredAdvisories(r);
  const rows =
    eolBadge(r) + protectionRow(r) + dispoBlockedAlert(r) + kickoff +
    classifyPrompt(r) + monitoredStale(r) +
    consolidationBanner(r) + foreignCollisionRows(r) + prChips(r) + dispoBumpNote(r) +
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

// Unblock constraint-capped (same-major) security patches: a high-effort headless
// Claude session raises the blocking manifest/parent constraints and opens one draft PR.
async function onUnblockDeps(r) {
  const n = (r.blocked || []).length;
  if (
    !(await confirmModal({
      confirmLabel: "Unblock deps",
      message:
        `Open an "unblock" PR for ${r.nameWithOwner}?\n\n` +
        `A headless Claude session (max effort) raises the manifest/parent constraint(s) capping ${n} same-major security patch(es), regenerates the lockfile, and pushes a DRAFT PR — which then flows into the CI auto-fix loop. Stays within the current major. Runs in the background.`,
    }))
  )
    return;
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: "⏳ Starting unblock session…", level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/unblock-deps", { repo: r.name });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId; job.status = data.status || "queued"; job.kind = "unblock";
    JOBS.set(r.name, job);
  } catch (e) {
    JOBS.delete(r.name);
    scheduleRender();
    alert("Couldn't start the unblock session: " + e.message);
  }
}

// Upgrade major-required advisories: one high-effort headless Claude session + draft PR
// PER major package, so each breaking upgrade is isolated and independently reviewable.
async function onUpgradeMajors(r) {
  // One PR per distinct package — a package with several advisories is a single upgrade —
  // so the count + preview match what the server opens.
  // Only open PRs for majors that don't already have one — exclude the already-open ones
  // so the count, list, and confirm label match what actually gets opened.
  const majors = majorsNeedingPR(r, dedupeMajors((r.packages || []).filter((p) => p.majorRequired)));
  const n = majors.length;
  if (!n) { alert("Every major upgrade for this repo already has an open PR."); return; }
  const list = majors.slice(0, 8).map((p) => `• ${p.pkg} ${p.installed || "?"} → ${p.target || p.patched || "?"}`).join("\n");
  if (
    !(await confirmModal({
      confirmLabel: `Upgrade ${n} major${n === 1 ? "" : "s"}`,
      message:
        `Open one draft PR per major upgrade for ${r.nameWithOwner}? (${n})\n\n${list}${n > 8 ? "\n…" : ""}\n\n` +
        `Each is a separate high-effort (max) headless Claude session that raises the constraint, installs, and updates this repo's code/tests for the breaking changes — then opens its own DRAFT PR so you can merge the green ones independently. This runs the sessions one after another and can take a while. Runs in the background.`,
    }))
  )
    return;
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: `⏳ Starting ${n} major upgrade session(s)…`, level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/upgrade-majors", { repo: r.name });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId; job.status = data.status || "queued"; job.kind = "major";
    JOBS.set(r.name, job);
  } catch (e) {
    JOBS.delete(r.name);
    scheduleRender();
    alert("Couldn't start the major upgrades: " + e.message);
  }
}

// Consolidate the repo's approved PRs into one release PR. The server re-fetches the
// approved open PRs (authoritative — it closes the originals), so the count here is just
// for the confirm copy; the server has the final say.
// Roll up goes through the same ordering modal as stack/sequence — the merge order affects
// which conflicts surface as the branches land on the release branch — then posts the chosen
// order to /api/rollup (which scopes to these tool PRs and closes them in the release PR's favor).
function onRollup(r) { openConsolidateOrder(r, "rollup"); }

// Stack the conflicting cluster: keep N PRs but make them merge in order. The server
// recomputes the cluster authoritatively, so the count here is just for the confirm copy.
function onStack(r) { openConsolidateOrder(r, "stack"); }
function onSequence(r) { openConsolidateOrder(r, "sequence"); }

// FIFO default order for a cluster: oldest PR first (bottom of stack / front of sequence),
// ties by number. Reliable for tool-opened PRs (createdAt ≈ number), but the user can
// override it by dragging in the ordering modal below.
function fifoOrder(prs) {
  return (prs || []).slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.number - b.number);
}

// Stack/Sequence ordering modal: show the cluster PRs in FIFO order, let the user drag to
// reorder (first = merged first / bottom of stack), then run with the chosen order. State in
// ORD while open.
let ORD = null;
function openConsolidateOrder(r, strategy) {
  const cl = consolidationCluster(r);
  let src, base, lock;
  if (strategy === "rollup") {
    // Rollup bundles ALL ready tool PRs targeting the base into ONE release PR — not just the
    // largest lockfile cluster — because the release regenerates EVERY lockfile, so PRs don't
    // need to share one to be combined (and leaving a same-base PR out just defers its conflict
    // to after the release merges). Stack/Sequence stay scoped to the conflict cluster below.
    base = cl ? cl.base : (r.defaultBranch || "main");
    src = fifoOrder((r.openPRs || []).filter((p) =>
      rollupEligible(p) &&
      (p.baseRefName || r.defaultBranch) === base &&
      !String(p.headRefName || "").startsWith("release/deps-")));
    const locks = [...new Set(src.flatMap((p) => p.lockfiles || []))];
    lock = locks.join(", ") || "the lockfile(s)";
  } else if (cl) {
    src = fifoOrder(cl.prs); base = cl.base; lock = cl.lock;
  } else { alert(`No cluster of same-base PRs sharing a lockfile to ${strategy}.`); return; }
  if (src.length < 2) { alert(`Need at least two PRs to ${strategy === "rollup" ? "roll up" : strategy}.`); return; }
  ORD = {
    repo: r.name,
    nameWithOwner: r.nameWithOwner || r.name,
    strategy,
    base,
    lock,
    prs: src.map((p) => ({ number: p.number, title: (p.title || "").trim() })),
    starting: false,
  };
  renderConsolidateOrder();
}

function closeConsolidateOrder() {
  ORD = null;
  const o = document.getElementById("ord-overlay");
  if (o) o.remove();
}

function renderConsolidateOrder() {
  if (!ORD) { const o = document.getElementById("ord-overlay"); if (o) o.remove(); return; }
  let overlay = document.getElementById("ord-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "ord-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return closeConsolidateOrder();
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "cancel") return closeConsolidateOrder();
      if (a.dataset.act === "run") return runConsolidateOrder();
    });
  }
  const v = ORD;
  const verb = v.strategy === "rollup" ? "Roll up" : v.strategy === "stack" ? "Stack" : "Sequence";
  const rows = v.prs.map((p, i) =>
    `<li class="ord-row" draggable="true" data-num="${p.number}">` +
    `<span class="ord-grip" title="Drag to reorder">⠿</span>` +
    `<span class="ord-pos">${i + 1}</span>` +
    `<span class="ord-pr">#${p.number}</span>` +
    `<span class="ord-title">${esc(p.title)}</span></li>`
  ).join("");
  const intro = v.strategy === "rollup"
    ? `Drag to set the order the branches are merged onto the release branch — <strong>top merges first</strong>, so conflicts surface in this order. All ${v.prs.length} collapse into ONE PR; the session resolves and regenerates the lockfile.`
    : v.strategy === "stack"
      ? `Drag to set the stack order — <strong>top of the list = bottom of the stack</strong> (merged first). Each PR is merged onto the one above it and its base retargeted accordingly.`
      : `Drag to set the merge order — <strong>top of the list merges first</strong>. Each PR auto-rebases once the one above it merges.`;
  const runLabel = v.strategy === "rollup" ? "Roll up → 1 PR" : `${verb} in this order`;
  // No .modal-body wrapper — it carries its own 18/20 padding, which doubled up with the
  // modal's. Content sits directly in the modal; the list itself scrolls when it's long.
  overlay.innerHTML =
    `<div class="modal ord-modal" role="dialog" aria-modal="true">` +
    `<div class="modal-title">${verb} ${v.prs.length} PRs — order on ${esc(v.nameWithOwner)}</div>` +
    `<p class="ord-intro">${intro}</p>` +
    `<p class="ord-meta">base <code>${esc(v.base)}</code> · <code>${esc(v.lock)}</code></p>` +
    `<ol class="ord-list">${rows}</ol>` +
    `<div class="modal-actions">` +
    `<button class="subtle" data-act="cancel">Cancel</button>` +
    `<button class="primary" data-act="run"${v.starting ? " disabled" : ""}>${v.starting ? "Starting…" : runLabel}</button>` +
    `</div></div>`;
  wireOrderDnD(overlay.querySelector(".ord-list"));
}

// Vanilla drag-and-drop reordering for the .ord-list. Reorders the DOM live, then syncs
// ORD.prs from the DOM on drop so the chosen order is what we submit.
function wireOrderDnD(list) {
  if (!list) return;
  let dragging = null;
  const afterElement = (y) => {
    const rows = [...list.querySelectorAll(".ord-row:not(.dragging)")];
    return rows.reduce((closest, el) => {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      return offset < 0 && offset > closest.offset ? { offset, el } : closest;
    }, { offset: -Infinity }).el;
  };
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".ord-row");
    if (!row) return;
    dragging = row;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragging) return;
    const after = afterElement(e.clientY);
    if (!after) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });
  list.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging = null;
    if (!ORD) return;
    const nums = [...list.querySelectorAll(".ord-row")].map((el) => Number(el.dataset.num));
    ORD.prs = nums.map((n) => ORD.prs.find((p) => p.number === n)).filter(Boolean);
    // Re-render to refresh the position numbers.
    renderConsolidateOrder();
  });
}

async function runConsolidateOrder() {
  if (!ORD || ORD.starting) return;
  const { repo, strategy } = ORD;
  const order = ORD.prs.map((p) => p.number);
  const n = order.length;
  const verbing = strategy === "rollup" ? "Rolling up" : strategy === "stack" ? "Stacking" : "Sequencing";
  ORD.starting = true;
  renderConsolidateOrder();
  JOBS.set(repo, { status: "queued", kind: strategy, events: [{ type: "log", line: `⏳ ${verbing} ${n} PR(s) in the chosen order…`, level: "info" }] });
  try {
    // Rollup keeps its own endpoint (it closes the originals); stack/sequence share /api/consolidate.
    const data = strategy === "rollup"
      ? await postJSON("/api/rollup", { repo, numbers: order })
      : await postJSON("/api/consolidate", { repo, strategy, order });
    const job = JOBS.get(repo) || { events: [] };
    job.jobId = data.jobId; job.status = data.status || "queued"; job.kind = strategy;
    JOBS.set(repo, job);
    closeConsolidateOrder();
    reattachJobs();
    toast(`${verbing} ${n} PR(s) on ${repo} — streaming on the card.`);
  } catch (e) {
    ORD.starting = false;
    JOBS.delete(repo);
    renderConsolidateOrder();
    alert(`Couldn't start the ${strategy === "rollup" ? "rollup" : strategy}: ` + e.message);
  }
}

// Sequence the conflicting cluster: leave N independent PRs but record a merge order and
// comment it on each. No code changes now — the dashboard auto-rebases each PR once its
// blocker merges. Fast (no session); resolves the lockfile clash lazily at merge time.

// Bring one stale/conflicting PR branch up to date: a headless Claude session merges the
// base in, regenerates lockfiles, resolves conflicts, and pushes. CI then re-runs.
async function onRebase(r, btn) {
  const number = Number(btn.dataset.number);
  if (
    !(await confirmModal({
      message:
        `Update PR #${number} on ${r.nameWithOwner} against ${r.defaultBranch || "the base branch"}?\n\n` +
        `A headless Claude session merges the base branch in, regenerates any lockfiles so the dependency changes stay coherent, resolves conflicts, and force-pushes the branch. CI then re-runs. Runs in the background.`,
      confirmLabel: "Rebase PR",
    }))
  )
    return;
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: `⏳ Starting rebase of PR #${number}…`, level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/rebase", { repo: r.name, number });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId; job.status = data.status || "queued"; job.kind = "rebase";
    JOBS.set(r.name, job);
  } catch (e) {
    JOBS.delete(r.name);
    scheduleRender();
    alert("Couldn't start the rebase: " + e.message);
  }
}

// ---- Session-log history viewer --------------------------------------------
// Past headless sessions for a repo (newest first) in a read-only overlay — so a run's
// output is reviewable after it finishes (the live job is pruned; the server keeps the log).
const SESSION_KIND_LABEL = { fix: "CI fix", review: "Review comments", rollup: "Rollup", stack: "Stack PRs", sequence: "Sequence PRs", rebase: "Rebase", major: "Major upgrades", unblock: "Unblock", bump: "Constraint bump", update: "Update PR", upgrade: "Runtime upgrade" };

async function openSessionHistory(r) {
  let sessions = [];
  try {
    const data = await getJSON(`/api/session-history?repo=${encodeURIComponent(r.name)}`);
    sessions = data.sessions || [];
  } catch (e) { toast("Couldn't load session history: " + e.message); return; }
  if (!sessions.length) { toast(`No session history yet for ${r.nameWithOwner || r.name}.`); return; }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onEsc, true); };
  const onEsc = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", onEsc, true);

  const items = sessions.map((s, i) => {
    const when = s.endedAt ? relTime(new Date(s.endedAt).toISOString()) : "running";
    const label = `${SESSION_KIND_LABEL[s.kind] || s.kind}${s.number ? ` · PR #${s.number}` : ""} · ${s.status === "error" ? "✗ error" : s.status} · ${when}`;
    return `<details class="sess"${i === 0 ? " open" : ""}>
      <summary>${esc(label)}</summary>
      <div class="runlog show sess-log" data-sess="${i}"></div>
    </details>`;
  }).join("");
  overlay.innerHTML =
    `<div class="modal sessions-modal" role="dialog" aria-modal="true">` +
    `<div class="rv-titlebar"><div class="modal-title">Session log — ${esc(r.nameWithOwner || r.name)}</div>` +
    `<button class="subtle" data-close>✕</button></div>` +
    `<div class="rv-subhead">${sessions.length} recent session${sessions.length === 1 ? "" : "s"} · newest first · kept in memory until server restart</div>` +
    `<div class="sessions-list">${items}</div>` +
    `<div class="modal-actions"><button class="primary" data-close>Close</button></div></div>`;
  document.body.appendChild(overlay);
  // Fill each session's log box from its archived event lines (handleEvent renders them).
  sessions.forEach((s, i) => {
    const box = overlay.querySelector(`.sess-log[data-sess="${i}"]`);
    if (box) for (const ev of s.lines || []) handleEvent(ev, box);
  });
}

// ---- Review console (per-PR overlay) ---------------------------------------
// Triage + address a PR's review threads (Copilot + humans) without leaving the dashboard:
// list them, auto-suggest fix/skip for the Copilot ones, let the user skip any, then run one
// headless session that addresses the selected threads, pushes, and replies-to + resolves
// each. State lives in REVIEW while the overlay is open; the overlay uses class
// "modal-overlay" so the global keyboard shortcuts stand down while it's up.
let REVIEW = null;

function onOpenReviewPanel(r, btn) { openReviewPanel(r, Number(btn.dataset.number)); }

async function openReviewPanel(r, number) {
  const pr = (r.openPRs || []).find((p) => p.number === number);
  REVIEW = { repo: r.name, nameWithOwner: r.nameWithOwner || r.name, number, prUrl: pr && pr.url, title: (pr && pr.title) || "", threads: null, verdicts: {}, skips: new Set(), cursor: 0, investigating: false, error: null };
  renderReviewPanel();
  try {
    const data = await getJSON(`/api/review-threads?repo=${encodeURIComponent(r.name)}&number=${number}`);
    if (!REVIEW || REVIEW.number !== number) return; // panel closed / switched while loading
    REVIEW.threads = (data.threads || []).filter((t) => !t.isResolved);
    REVIEW.cursor = 0;
    renderReviewPanel();
    // Auto-triage the Copilot threads (advisory only — the user still picks + clicks Address).
    if (REVIEW.threads.some((t) => t.isCopilot)) {
      REVIEW.investigating = true;
      renderReviewPanel();
      try {
        const inv = await postJSON("/api/review-investigate", { repo: r.name, number });
        if (REVIEW && REVIEW.number === number) REVIEW.verdicts = inv.verdicts || {};
      } catch { /* advisory only — leave verdicts empty */ }
      if (REVIEW && REVIEW.number === number) { REVIEW.investigating = false; renderReviewPanel(); }
    }
  } catch (e) {
    if (REVIEW && REVIEW.number === number) { REVIEW.error = e.message; renderReviewPanel(); }
  }
}

function closeReviewPanel() {
  REVIEW = null;
  const o = document.getElementById("review-overlay");
  if (o) o.remove();
}

function reviewThreadHtml(t, i) {
  const v = REVIEW;
  const skipped = v.skips.has(t.id);
  const cursor = i === v.cursor ? " cursor" : "";
  const who = t.isCopilot ? "🤖 Copilot" : `👤 @${esc(t.author || "reviewer")}`;
  const verdict = v.verdicts[t.id];
  let badge = "";
  if (t.isCopilot) {
    if (v.investigating && !verdict) badge = `<span class="rv-verdict pending"><span class="spin tiny"></span>investigating</span>`;
    else if (verdict) badge = `<span class="rv-verdict ${verdict.recommend === "skip" ? "skip" : "fix"}">${verdict.recommend === "skip" ? "⚠ likely skip" : "✅ worth fixing"}</span>`;
  }
  const reason = verdict && verdict.reason ? `<div class="rv-reason">${esc(verdict.reason)}</div>` : "";
  const loc = `${esc(t.path || "")}${t.line ? ":" + t.line : ""}`;
  // Only when GitHub can no longer place the comment in the current diff (`anchorLost`) —
  // NOT on the GraphQL isOutdated flag, which goes true as soon as any newer commit exists
  // and would badge threads GitHub itself still shows as current.
  const outdated = t.anchorLost
    ? ` <span class="rv-outdated" title="The line this was written against has changed since — the comment is still unresolved, but the snippet below may be stale">outdated</span>`
    : "";
  return `<div class="rv-thread${skipped ? " skipped" : ""}${cursor}" data-tid="${esc(t.id)}">
    <label class="rv-skip" title="Leave this comment out of the fix (it stays open)"><input type="checkbox" data-act="skip" data-id="${esc(t.id)}"${skipped ? " checked" : ""}> skip</label>
    <div class="rv-main">
      <div class="rv-head">${who} · <code>${loc}</code>${outdated} ${badge} ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" title="Open on GitHub">↗</a>` : ""}</div>
      ${reason}
      <div class="rv-body">${mdInline(t.body || "")}</div>
      ${t.diffHunk ? `<pre class="rv-diff">${esc(t.diffHunk)}</pre>` : ""}
    </div>
  </div>`;
}

function renderReviewPanel() {
  if (!REVIEW) { const o = document.getElementById("review-overlay"); if (o) o.remove(); return; }
  let overlay = document.getElementById("review-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "review-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    // Delegated handlers survive the innerHTML re-renders below (they're on the overlay).
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return closeReviewPanel();
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "close") return closeReviewPanel();
      if (a.dataset.act === "address") return addressReview();
      if (a.dataset.act === "investigate") return reinvestigate();
    });
    overlay.addEventListener("change", (e) => {
      const cb = e.target.closest('input[data-act="skip"]');
      if (!cb || !REVIEW) return;
      if (cb.checked) REVIEW.skips.add(cb.dataset.id); else REVIEW.skips.delete(cb.dataset.id);
      const th = overlay.querySelector(`.rv-thread[data-tid="${cssEscape(cb.dataset.id)}"]`);
      if (th) th.classList.toggle("skipped", cb.checked);
      updateAddressBtn(); // targeted — avoid a full re-render that would disrupt the log
    });
  }
  const v = REVIEW;
  const copilotN = (v.threads || []).filter((t) => t.isCopilot).length;
  const body = v.error
    ? `<div class="rv-empty">Couldn't load review threads: ${esc(v.error)}</div>`
    : v.threads == null
      ? `<div class="rv-loading"><span class="spin"></span> Loading review threads…</div>`
      : (!v.threads.length
          ? `<div class="rv-empty">No unresolved review comments 🎉</div>`
          : v.threads.map((t, i) => reviewThreadHtml(t, i)).join(""));
  const hint = v.threads && v.threads.length
    ? `<div class="rv-hint"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> skip · <kbd>a</kbd> address · <kbd>h</kbd>/<kbd>l</kbd> prev/next PR · <kbd>o</kbd> open · <kbd>esc</kbd> close</div>`
    : "";
  const titleTxt = `${esc(v.nameWithOwner)} · PR #${v.number}${v.title ? " — " + esc(v.title) : ""}`;
  const investBtn = copilotN > 0
    ? `<button class="subtle" data-act="investigate"${v.investigating ? " disabled" : ""}>${v.investigating ? `<span class="spin tiny"></span>Investigating` : "↻ Re-investigate Copilot"}</button>`
    : "";
  overlay.innerHTML =
    `<div class="modal review-modal" role="dialog" aria-modal="true">` +
    `<div class="rv-titlebar"><div class="modal-title">${titleTxt}</div>` +
    `<div class="rv-titleacts">${v.prUrl ? `<a class="subtle" href="${esc(v.prUrl)}" target="_blank" rel="noopener">↗ GitHub</a>` : ""}<button class="subtle" data-act="close">✕</button></div></div>` +
    `<div class="rv-subhead">${v.threads == null ? "" : `${v.threads.length} unresolved thread${v.threads.length === 1 ? "" : "s"}`}${copilotN ? ` · ${copilotN} from Copilot` : ""} ${investBtn}</div>` +
    `<div class="rv-threads">${body}</div>` +
    hint +
    `<div class="modal-actions rv-actions">` +
    // Once there are no unresolved threads (e.g. after a run resolved them all) there's
    // nothing to address — replace the dead disabled Address button with a clear Done.
    (Array.isArray(v.threads) && v.threads.length === 0
      ? `<button class="primary" data-act="close">Done</button>`
      : `<button class="subtle" data-act="close">Close</button><button class="primary" data-act="address" id="rv-address"></button>`) +
    `</div></div>`;
  updateAddressBtn();
}

function selectedThreadIds() {
  if (!REVIEW || !REVIEW.threads) return [];
  return REVIEW.threads.filter((t) => !REVIEW.skips.has(t.id)).map((t) => t.id);
}

function updateAddressBtn() {
  const btn = document.getElementById("rv-address");
  if (!btn || !REVIEW) return;
  const n = selectedThreadIds().length;
  btn.disabled = n === 0;
  btn.textContent = `Address ${n} selected comment${n === 1 ? "" : "s"}`;
}

async function addressReview() {
  if (!REVIEW) return;
  const ids = selectedThreadIds();
  if (!ids.length) return;
  if (
    !(await confirmModal({
      confirmLabel: `Address ${ids.length}`,
      message:
        `Address ${ids.length} review comment${ids.length === 1 ? "" : "s"} on ${REVIEW.nameWithOwner} #${REVIEW.number}?\n\n` +
        `A headless Claude session edits the PR branch to address each selected comment, pushes, then replies to and resolves each thread on GitHub. Skipped comments stay open. Runs in the background.`,
    }))
  )
    return;
  const repo = REVIEW.repo;
  const number = REVIEW.number;
  JOBS.set(repo, { status: "queued", kind: "review", events: [{ type: "log", line: `⏳ Addressing ${ids.length} review comment(s) on PR #${number}…`, level: "info" }] });
  try {
    const data = await postJSON("/api/review-address", { repo, number, threadIds: ids });
    const job = JOBS.get(repo) || { events: [] };
    job.jobId = data.jobId; job.status = data.status || "queued"; job.kind = "review";
    JOBS.set(repo, job);
    // Submitting closes the console — the session now streams onto the repo's card (and is
    // kept in session history afterward). reattachJobs wires the live log to the card.
    closeReviewPanel();
    reattachJobs();
    toast(`Addressing ${ids.length} comment(s) on #${number} — streaming on the card.`);
  } catch (e) {
    JOBS.delete(repo);
    alert("Couldn't start addressing the comments: " + e.message);
  }
}

async function reinvestigate() {
  if (!REVIEW || REVIEW.investigating || !REVIEW.threads) return;
  REVIEW.investigating = true;
  renderReviewPanel();
  try {
    const inv = await postJSON("/api/review-investigate", { repo: REVIEW.repo, number: REVIEW.number });
    if (REVIEW) REVIEW.verdicts = inv.verdicts || {};
  } catch { /* advisory */ }
  if (REVIEW) { REVIEW.investigating = false; renderReviewPanel(); }
}

// Called from handleJobEvent when a review job finishes — refresh the panel's threads
// (resolved ones drop) and the PR row's unresolved count.
async function onReviewJobDone(repo) {
  pollPRStatus(true);
  if (!REVIEW || REVIEW.repo !== repo) return; // panel is normally closed on submit
  try {
    const data = await getJSON(`/api/review-threads?repo=${encodeURIComponent(repo)}&number=${REVIEW.number}`);
    if (REVIEW && REVIEW.repo === repo) {
      REVIEW.threads = (data.threads || []).filter((t) => !t.isResolved);
      REVIEW.cursor = Math.min(REVIEW.cursor || 0, Math.max(0, REVIEW.threads.length - 1));
      renderReviewPanel();
    }
  } catch { if (REVIEW) renderReviewPanel(); }
}

// Lightweight re-render of just the thread list (cursor move / skip toggle) — leaves the
// streaming log untouched and keeps the focused thread in view.
function renderThreads() {
  const cont = document.querySelector("#review-overlay .rv-threads");
  if (!cont || !REVIEW || !REVIEW.threads) return;
  cont.innerHTML = REVIEW.threads.map((t, i) => reviewThreadHtml(t, i)).join("");
  updateAddressBtn();
  const cur = cont.querySelector(".rv-thread.cursor");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function moveReviewCursor(d) {
  const n = (REVIEW.threads || []).length;
  if (!n) return;
  REVIEW.cursor = Math.max(0, Math.min(n - 1, (REVIEW.cursor || 0) + d));
  renderThreads();
}

function toggleCursorSkip() {
  const t = (REVIEW.threads || [])[REVIEW.cursor];
  if (!t) return;
  if (REVIEW.skips.has(t.id)) REVIEW.skips.delete(t.id); else REVIEW.skips.add(t.id);
  renderThreads();
}

// Every open PR (across the model) that has unresolved review comments, in display order —
// the queue ]/[ steps through so you can churn your whole review backlog from the panel.
function reviewPRCandidates() {
  const out = [];
  for (const r of (STATE.model && STATE.model.repos) || []) {
    if (r.archived) continue;
    for (const pr of r.openPRs || []) if ((pr.reviewUnresolved || 0) > 0) out.push({ r, number: pr.number });
  }
  return out;
}

function gotoReviewPR(d) {
  if (!REVIEW) return;
  const cands = reviewPRCandidates();
  if (!cands.length) return;
  let idx = cands.findIndex((c) => c.r.name === REVIEW.repo && c.number === REVIEW.number);
  if (idx < 0) idx = 0;
  const next = idx + d;
  if (next < 0 || next >= cands.length) { toast(d > 0 ? "Last PR with review comments." : "First PR with review comments."); return; }
  openReviewPanel(cands[next].r, cands[next].number);
}

// Keyboard control for the review console. Active only while the panel is open; the global
// shortcuts already stand down (they bail on any .modal-overlay). Bails while a confirm
// dialog sits on top so Esc/Enter there don't also drive the panel.
function reviewKeydown(e) {
  if (!REVIEW) return;
  if (document.querySelector(".confirm-overlay")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser/OS combos alone
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); return closeReviewPanel(); }
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); return moveReviewCursor(1); }
  if (k === "k" || k === "ArrowUp") { e.preventDefault(); return moveReviewCursor(-1); }
  if (k === "l" || k === "L") { e.preventDefault(); return gotoReviewPR(1); }
  if (k === "h" || k === "H") { e.preventDefault(); return gotoReviewPR(-1); }
  if (k === "a") { e.preventDefault(); return addressReview(); }
  if (!(REVIEW.threads || []).length) return;
  if (k === "x" || k === " ") { e.preventDefault(); return toggleCursorSkip(); }
  if (k === "o") {
    e.preventDefault();
    const t = REVIEW.threads[REVIEW.cursor];
    if (t && t.url) window.open(t.url, "_blank", "noopener");
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

// Who the "Request review" control offers for one PR. The repo's OWN history leads
// (most-recent-first, so the person you usually ask is the default); a repo nobody has
// reviewed yet has no history to suggest from, so it falls back to the org roster rather
// than showing nothing. Anyone already requested on THIS PR is flagged, not hidden — the
// menu shows them ticked so it's clear why they aren't offered, and the default skips to
// the first person who could still be asked.
function reviewerChoices(r, pr) {
  const already = new Set((pr.reviewers || []).map(String));
  const history = r.reviewerOptions || [];
  const fromHistory = history.length > 0;
  const pool = fromHistory ? history : ((STATE.model && STATE.model.orgMembers) || []);
  const opts = pool.map((o) => ({ ...o, requested: already.has(o.display) }));
  return { opts, fromHistory, def: opts.find((o) => !o.requested) || null };
}

// One-click "request review from @who" on a single PR (who = r.suggestedReviewer,
// resolved server-side). Reflects the request in the model + re-renders, no Refresh.
// `btn` carries the choice (data-number / data-reviewer); `busyEl` is where to show it
// working. They differ when the click came from the dropdown — that menu item is hidden
// the moment the menu closes, so the feedback belongs on the chip that stays visible.
async function onRequestReview(r, btn, busyEl) {
  const number = Number(btn.dataset.number);
  const reviewer = btn.dataset.reviewer;
  const display = reviewer.split("/").pop();
  const target = busyEl || btn;
  target.disabled = true;
  const old = target.innerHTML;
  target.textContent = "Requesting…";
  try {
    const data = await postJSON("/api/request-review", { repo: r.name, number, reviewer });
    const pr = (r.openPRs || []).find((p) => p.number === number);
    if (pr) {
      pr.reviewers = data.reviewers || Array.from(new Set([...(pr.reviewers || []), display]));
      if (!pr.reviewDecision) pr.reviewDecision = "REVIEW_REQUIRED";
    }
    scheduleRender();
  } catch (e) {
    target.disabled = false;
    target.innerHTML = old;
    alert("Couldn't request review: " + e.message);
  }
}

// Flip a draft PR to ready-for-review on GitHub, then update the model + re-render.
async function onReadyForReview(r, btn) {
  const number = Number(btn.dataset.number);
  if (!(await confirmModal({ message: `Mark PR #${number} on ${r.nameWithOwner} as ready for review?\n\nThis flips it out of draft on GitHub.`, confirmLabel: "Ready for review" }))) return;
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.textContent = "Updating…";
  try {
    await postJSON("/api/ready-for-review", { repo: r.name, number });
    const pr = (r.openPRs || []).find((p) => p.number === number);
    if (pr) pr.draft = false;
    scheduleRender();
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = old;
    alert("Couldn't mark ready: " + e.message);
  }
}

// Merge one approved PR. Always confirms — a merge is irreversible, so this deliberately
// has no "don't ask again" key, unlike Archive. The server re-reads the PR from GitHub and
// picks a merge method the repo allows, so the outcome it reports back (method, whether the
// branch went) is what the toast states rather than what we assumed here.
async function onMergePR(r, btn) {
  const number = Number(btn.dataset.number);
  const pr = (r.openPRs || []).find((p) => p.number === number);
  const base = (pr && pr.baseRefName) || r.defaultBranch || "the base branch";
  const ciState = pr && pr.ci && pr.ci.state;
  // Approval doesn't imply green: an approved PR can still be sitting on failing or
  // in-flight checks. Say so in the modal (and make it a red confirm) rather than letting a
  // one-word button quietly ship a red build.
  const ciNote =
    ciState === "failing"
      ? `\n\n⚠️ Checks are FAILING on this PR${pr.ci.failing && pr.ci.failing.length ? ` (${pr.ci.failing.join(", ")})` : ""} — merging anyway ships a red build.`
      : ciState === "pending"
        ? "\n\nChecks are still running — merging now doesn't wait for them."
        : "";
  // Bottom of a stack: squashing would rewrite the commits the PRs above are built on and
  // strand them, so this merges as a merge commit and keeps the branch. Say so up front —
  // it's a visible departure from "squash and delete the branch".
  const kids = pr ? stackChildNumbers(pr, r) : [];
  const stackNote = kids.length
    ? `\n\n🥞 ${kids.map((n) => "#" + n).join(", ")} ${kids.length === 1 ? "is" : "are"} stacked on this one, so it merges as a merge commit (not a squash) and keeps the branch — squashing would rewrite the commits ${kids.length === 1 ? "that PR is" : "those PRs are"} built on.`
    : "";
  const ok = await confirmModal({
    message:
      `Merge PR #${number} into ${base}?\n\n` +
      `${r.nameWithOwner || r.name}${pr && pr.title ? ` · ${pr.title}` : ""}\n\n` +
      (kids.length
        ? `Merges it on GitHub. Branch protection still applies — this never bypasses it.`
        : `Merges it on GitHub (squash where the repo allows it) and deletes the branch. Branch protection still applies — this never bypasses it.`) +
      stackNote +
      ciNote,
    danger: ciState === "failing",
    confirmLabel: "Merge PR",
  });
  if (!ok) return;
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.textContent = "Merging…";
  try {
    const data = await postJSON("/api/merge-pr", { repo: r.name, number });
    // Drop the merged PR locally so the card leaves the Approved tab immediately — the same
    // move the server just made to its cache, so the next poll agrees instead of resurrecting it.
    r.openPRs = (r.openPRs || []).filter((p) => p.number !== number);
    r.pending = r.openPRs.length > 0;
    const how = { squash: "Squash-merged", merge: "Merged", rebase: "Rebase-merged" }[data.method] || "Merged";
    // The server's stack check queries GitHub, so it sees children the model can't (a human's
    // branch based on ours). When it kept the branch for one, say so — otherwise "merged" reads
    // as if the usual delete-the-branch cleanup happened, and it deliberately didn't.
    const kept = !data.branchDeleted && (data.stackedChildren || []).length
      ? ` · branch kept for ${data.stackedChildren.map((n) => "#" + n).join(", ")}`
      : "";
    toast(`✓ ${how} #${number} into ${data.base || base}${kept}${r.pending ? "" : " — Refresh to re-scan this repo's alerts"}`);
    scheduleRender();
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = old;
    alert("Couldn't merge: " + e.message);
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
  // On a PR-lifecycle tab the card shows only that tab's PRs, so the edge accent should
  // reflect THOSE (a Pending card mustn't go green just because a sibling PR is approved).
  const prs = PR_TABS.has(STATE.tab) ? (r.openPRs || []).filter((p) => prLifecycleState(p, r) === STATE.tab) : (r.openPRs || []);
  if (prs.some((p) => p.reviewDecision === "APPROVED")) return " prio-ready";
  if (prs.length) return " prio-pr";
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
  on(".act-unblock", onUnblockDeps);
  on(".act-upgrade-majors", onUpgradeMajors);
  on(".act-rollup", onRollup);
  on(".act-stack", onStack);
  on(".act-sequence", onSequence);
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
  const ms = el.querySelector(".menu-sessions");
  if (ms) ms.addEventListener("click", () => { closeAllMenus(); openSessionHistory(r); });
  const ma = el.querySelector(".menu-archive");
  if (ma) ma.addEventListener("click", () => { closeAllMenus(); onArchive(r, el); });
  const mea = el.querySelector(".menu-email-alt");
  if (mea) mea.addEventListener("click", () => { closeAllMenus(); onEmail(r, el, mea.dataset.mode); });
  wireContactForm(r, el);
  el.querySelectorAll(".act-copy-pr").forEach((b) =>
    b.addEventListener("click", () => copyRich(anchorHtml(b.dataset.url, b.dataset.label), b.dataset.url, b))
  );
  el.querySelectorAll(".act-request-review").forEach((b) => b.addEventListener("click", () => onRequestReview(r, b)));
  // Opening the picker snapshots who's currently requested, so the close can diff against it.
  el.querySelectorAll(".rr-caret").forEach((c) =>
    c.addEventListener("click", () => {
      const menu = c.parentElement.querySelector(".rr-menu");
      if (menu && !menu.hidden) beginReviewerEdit(r.name, menu); // toggleMenu already ran
    })
  );
  // Ticking a name only edits local state — the batch is sent by closeAllMenus.
  el.querySelectorAll(".rr-opt[data-reviewer]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // keep the menu open; this is an editor, not an action list
      if (!RR_EDIT) return;
      const handle = b.dataset.reviewer;
      const on = !RR_EDIT.current.has(handle);
      if (on) RR_EDIT.current.add(handle);
      else RR_EDIT.current.delete(handle);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.querySelector(".rr-tick").textContent = on ? "✓" : "";
    })
  );
  el.querySelectorAll(".act-ready-pr").forEach((b) => b.addEventListener("click", () => onReadyForReview(r, b)));
  // Per-PR buttons: bind EACH (a card can hold several PRs) and pass the button so the
  // handler reads the right data-number — `on()` only binds the first match + passes the card.
  el.querySelectorAll(".act-rebase").forEach((b) => b.addEventListener("click", () => onRebase(r, b)));
  el.querySelectorAll(".act-review-comments").forEach((b) => b.addEventListener("click", () => onOpenReviewPanel(r, b)));
  el.querySelectorAll(".act-merge-pr").forEach((b) => b.addEventListener("click", () => onMergePR(r, b)));
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

// Is the reader parked at the bottom of this log box? Measure this BEFORE appending,
// so a tall just-added line (Claude output is long + pre-wrapped) can't be mistaken
// for "the user scrolled up."
function atBoxBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

// Pin a log box to its newest line. The box is its own overflow:auto scroller, so
// scrollTop stays local — but restore the window scroll defensively in case the
// browser tried to bring the box into view. Keeps the outer page from jumping.
function pinBoxToBottom(box) {
  const x = window.scrollX;
  const y = window.scrollY;
  box.scrollTop = box.scrollHeight;
  if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
}

// Render a SAFE inline-markdown subset for streamed log lines: escape first (so it's
// XSS-safe — the only tags in the output are ones we inject), then convert `code`,
// **bold**, and a leading #/##/### header. Deliberately NOT italic: `_` and `*` appear
// constantly in package names and paths (administrate-field-boolean_to_yes_no) and would
// be mangled. Per-line by design — the log streams a line at a time, so multi-line
// constructs (fenced blocks, lists) aren't reassembled, but the inline noise is gone.
function mdInline(text) {
  let s = esc(text);
  const h = s.match(/^(#{1,6})\s+(.*)$/);
  if (h) s = h[2]; // strip the leading hashes; the whole line becomes a heading below
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  return h ? `<strong>${s}</strong>` : s;
}

function logLine(box, text, cls) {
  const follow = atBoxBottom(box); // decide BEFORE appending; the new line's height must not veto it
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.innerHTML = mdInline(text); // inline markdown (escaped first); plain text falls through unchanged
  box.appendChild(div);
  if (follow) pinBoxToBottom(box); // already committed to following — pin unconditionally
}

// Kick off a background update-PR job. Returns immediately; progress streams in
// over /api/events (see startEventStream/handleJobEvent), so the work survives
// tab switches and even a full page reload.
async function onUpdate(r, el) {
  // Mirror the card button's verb: an open PR → "Re-run" (refresh it), a covered/
  // blocked gem with no PR → "Re-check" (re-resolve), otherwise → "Create".
  const n = r.packages ? r.packages.length : 0;
  const d = r.disposition;
  let confirmLabel, message;
  if (r.pending) {
    confirmLabel = "Re-run update";
    message = `Re-run the dependency update for ${r.nameWithOwner}?\n\nA PR already exists. This re-clones, re-runs lockfile-only updates for the ${n} flagged package(s), and refreshes that PR's branch (force-with-lease) — or, if the advisories are already resolved, closes the now-obsolete PR. Runs in the background — you can keep working.`;
  } else if (d && (d.state === "covered" || d.state === "blocked")) {
    confirmLabel = "Re-check";
    message = `Re-check ${r.nameWithOwner}?\n\nRe-clones and re-resolves this gem's disposition against the current advisories. It only opens a PR if an actual change is produced. Runs in the background.`;
  } else {
    confirmLabel = "Create update PR";
    message = `Open a dependency-update PR for ${r.nameWithOwner}?\n\nClones the repo, branches, runs lockfile-only updates for the ${n} flagged package(s), pushes, and opens a DRAFT pull request. Runs in the background — you can keep working.`;
  }
  if (!(await confirmModal({ message, confirmLabel }))) return;
  JOBS.set(r.name, { status: "queued", events: [{ type: "log", line: "⏳ Starting…", level: "info" }] });
  reattachJobs();
  try {
    const data = await postJSON("/api/update-pr", { repo: r.name });
    const job = JOBS.get(r.name) || { events: [] };
    job.jobId = data.jobId;
    job.status = data.status || "queued";
    JOBS.set(r.name, job);
    // The server re-checked this repo (fresh alerts + live PR reconcile) before
    // starting — apply it now so a merged PR drops out of Pending and any new
    // advisory shows up immediately, without a manual Refresh.
    if (data.model && STATE.model) {
      const i = STATE.model.repos.findIndex((x) => x.name === r.name);
      if (i >= 0) Object.assign(STATE.model.repos[i], data.model);
      scheduleRender();
      reattachJobs();
    }
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
  const label = { fix: "🔧 Fixing CI…", bump: "⛔ Bumping constraints…", upgrade: "⬆ Upgrading…", unblock: "🔧 Unblocking…", major: "⬆ Upgrading majors…", rollup: "🧬 Rolling up…", stack: "🥞 Stacking…", sequence: "⏱ Sequencing…", rebase: "⟳ Rebasing…" }[kind] || "Working…";
  return `<span class="spin"></span>${label}`;
}

let _renderTimer = null;
function scheduleRender() {
  if (_renderTimer) return;
  // A poll-driven rebuild replaces the cards wholesale, which yanks an open dropdown out
  // of the DOM mid-interaction: the CI poll fires every 10s, so opening the reviewer picker
  // shortly after a CI/review change would see it vanish, then "work" on the second try
  // once the snapshot settled. Worse for the picker specifically — it holds ticks that
  // haven't been applied yet, so the rebuild would silently discard them. So wait for the
  // menu to close instead of dropping the update; re-arming keeps the refresh pending
  // however long it stays open.
  const attempt = () => {
    if (document.querySelector(".dd-menu:not([hidden])")) { _renderTimer = setTimeout(attempt, 300); return; }
    _renderTimer = null;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  };
  _renderTimer = setTimeout(attempt, 180);
}

// Single list of the card actions toggled while a job runs, so the disable
// set (reattachJobs) and re-enable sets (finishJob, handleJobEvent) can't drift.
function setCardActionsDisabled(card, on) {
  card
    .querySelectorAll(".cls-btn, .cls-opt, .act-notify, .act-email, .act-dismiss, .dd-trigger, .act-unblock, .act-upgrade-majors")
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
    const btn = card.querySelector(".act-update, .act-bump, .act-unblock, .act-upgrade-majors");
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
  // Attach the run's blocked survivors (advisories a manifest constraint caps below
  // their patched floor) so the card shows them live. An update run always reports
  // `blocked` — an empty array clears a stale one. Render happens via the branches below.
  if (r && Array.isArray(evt.blocked)) r.blocked = evt.blocked.length ? evt.blocked : null;

  // A no-change run re-fetched this repo's alerts + tool PRs — apply the fresh snapshot
  // so the card shows real counts/pending immediately (e.g. 0 after a merge resolved the
  // advisories) instead of stale pre-merge data, without waiting for a full Refresh.
  if (r && evt.refreshed) {
    Object.assign(r, evt.refreshed); // counts, ecosystems, packages, openPRs, pending
    // Carry the run's gem verdict too (a no-change gem run still resolves covered/blocked).
    if (evt.disposition) r.disposition = evt.disposition;
    // Belt-and-suspenders: drop a just-closed PR even if GitHub's open-PR list lags.
    if (evt.closedPRs && evt.closedPRs.length && r.openPRs) {
      const closed = new Set(evt.closedPRs);
      r.openPRs = r.openPRs.filter((p) => !closed.has(p.url));
      r.pending = r.openPRs.length > 0;
    }
    // The model is alert-driven: a repo with no open alerts and no in-flight PR is
    // exactly what a full Refresh would shed (buildModel only includes repos with open
    // alerts). Drop it now so a freshly-cleaned repo doesn't linger in Maintained with
    // a "0 alerts" card — render() recomputes the tabs + headline stats from the model.
    if ((r.counts ? r.counts.total : 0) === 0 && !r.pending) {
      const i = STATE.model.repos.indexOf(r);
      if (i >= 0) STATE.model.repos.splice(i, 1);
    }
    scheduleRender(); // a fresh card render also re-enables the action buttons
    return;
  }
  // A no-change re-check may have closed now-obsolete tool PRs — drop them from the
  // local model so the repo leaves the Pending tab live (mirrors the server cache).
  const closedAny = !!(r && evt.closedPRs && evt.closedPRs.length);
  if (closedAny) {
    const closed = new Set(evt.closedPRs);
    if (r.openPRs) r.openPRs = r.openPRs.filter((p) => !closed.has(p.url));
    r.pending = !!(r.openPRs && r.openPRs.length);
  }
  if (r && evt.prUrls && evt.prUrls.length) {
    // Major-upgrade fan-out: one PR per major. Merge them all into openPRs (don't clobber).
    r.pending = true;
    r.openPRs = r.openPRs || [];
    const metaFor = new Map((evt.prs || []).map((p) => [p.url, p]));
    for (const url of evt.prUrls) {
      if (r.openPRs.some((p) => p.url === url)) continue;
      const num = (url.match(/\/pull\/(\d+)/) || [])[1];
      const m = metaFor.get(url) || {};
      // Stamp checks-running so the PR buckets straight into Pending PR (not transiently onto
      // Passing via the repo-level CI fallback) and shows its indicator until the poll lands.
      r.openPRs.push({ number: num ? Number(num) : "?", url, draft: true, title: m.title || "", headRefName: m.branch || null, ci: { state: "pending" } });
    }
    scheduleRender(); // graduates the repo into the Pending PR tab
  } else if (evt.prUrl && r) {
    const num = (evt.prUrl.match(/\/pull\/(\d+)/) || [])[1];
    r.pending = true;
    // Merge (don't clobber): a repo can have several open tool PRs — a runtime
    // upgrade and a prior-day update alongside today's. Replacing the array hid
    // them until the next Refresh. Mirrors the server-side merge in runJob.
    r.openPRs = r.openPRs || [];
    if (!r.openPRs.some((p) => p.url === evt.prUrl)) {
      r.openPRs.push({ number: num ? Number(num) : "?", url: evt.prUrl, draft: true, headRefName: evt.branch || null, title: evt.title || "", ci: { state: "pending" } });
    }
    scheduleRender(); // graduates the repo into the Pending PR tab
  } else if (r && evt.disposition) {
    // A gem resolved to covered/blocked — attach the verdict and re-render so it
    // moves to the Covered tab (covered) or shows the constraint-bump CTA (blocked).
    r.disposition = evt.disposition;
    scheduleRender();
  } else if (closedAny) {
    // Re-render so the closed PR drops and the repo leaves Pending; this also
    // rebuilds the card with its action buttons re-enabled.
    scheduleRender();
  } else if (r && r.blocked && r.blocked.length) {
    // No PR, but the run surfaced blocked survivors — re-render so the card shows them.
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

// A major-upgrade fan-out opens one PR per major and streams a "pr" event as each
// lands. Merge it into the model and re-render so it shows in the Pending PR tab right
// away — without ending the still-running job (render→reattachJobs restores the live
// runlog + busy buttons). Idempotent on url, so a reconnect replay is safe.
function mergeStreamedPR(repo, evt) {
  const r = STATE.model && STATE.model.repos.find((x) => x.name === repo);
  if (!r || !evt.prUrl || (r.openPRs && r.openPRs.some((p) => p.url === evt.prUrl))) return;
  const num = (evt.prUrl.match(/\/pull\/(\d+)/) || [])[1];
  r.pending = true;
  r.openPRs = r.openPRs || [];
  // Stamp checks-running so a brand-new PR buckets straight into Pending PR and shows its
  // indicator — without it, the repo-level CI fallback can flash it onto Passing, then the
  // first poll re-buckets it to Pending and it appears to "vanish" from the Passing tab.
  r.openPRs.push({ number: num ? Number(num) : "?", url: evt.prUrl, draft: true, headRefName: evt.branch || null, title: evt.title || "", ci: { state: "pending" } });
  scheduleRender();
  pollPRStatus(true); // refresh now so the real CI state lands promptly, not on the next 10s tick
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
    const btn = card && card.querySelector(".act-update, .act-bump, .act-unblock, .act-upgrade-majors, .act-rollup, .act-stack, .act-sequence");
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
    // Fix and rebase both edit an EXISTING PR branch (no new/closed PR) — just refresh the
    // PR's CI + merge state; don't run finishJob's move-into-Pending logic.
    if (job.kind === "fix" || job.kind === "rebase") { JOBS.delete(repo); pollPRStatus(true); }
    else if (job.kind === "review") { JOBS.delete(repo); onReviewJobDone(repo); }
    // Stack/sequence don't open or close PRs — they retarget bases / record an ordering. No
    // finishJob move logic; just clear the job and refresh PR meta so the card reflects it.
    else if (job.kind === "stack" || job.kind === "sequence") { JOBS.delete(repo); pollPRStatus(true); }
    else finishJob(repo, evt);
  } else if (evt.type === "pr") {
    mergeStreamedPR(repo, evt); // a fan-out PR opened mid-run — surface it now; job keeps running
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
      logLine(box, "✓ Pull request opened", "success"); // pins to bottom if following
      const follow = atBoxBottom(box); // re-measure: logLine just pinned us there
      const a = document.createElement("a");
      a.href = ev.prUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "pr-link";
      a.textContent = ev.prUrl;
      box.appendChild(a);
      if (follow) pinBoxToBottom(box); // the raw <a> append must not veto the follow either
    } else if (ev.changed === false) {
      const n = (ev.notes || []).length;
      logLine(
        box,
        n ? `↑ Couldn't auto-update — ${n} specific note${n > 1 ? "s" : ""} above explain${n > 1 ? "" : "s"} exactly what's needed.` : "No changes produced — nothing flagged here.",
        "warn"
      );
    }
    // Both the prUrl link and every logLine above already pin to the bottom when following.
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
// Review console: j/k move comments, x skip, a address, h/l prev/next PR (capture so it
// runs before the tab-nav handlers; it self-gates on REVIEW being open).
document.addEventListener("keydown", reviewKeydown, true);
// Consolidation order modal: Esc closes (self-gates on ORD; ignores when a confirm sits on top).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ORD && !document.querySelector(".confirm-overlay")) { e.preventDefault(); closeConsolidateOrder(); }
}, true);

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
  setInterval(() => pollPRStatus(), 10000); // reads the server's batched cache (cheap)
  setInterval(() => pollEolStatus(), 120000);
})();
