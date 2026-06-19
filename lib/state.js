"use strict";

// Per-repo triage state, persisted as small human-readable JSON files at the
// project root (each safe to commit as an audit record). Every store is the
// same shape — `{ <rootKey>: { ... } }` — built by the jsonStore factory below.

const fs = require("fs");
const path = require("path");

// One JSON-file store: load() parses the file and returns the rootKey object
// (or {} on a missing/corrupt file); save(data) writes it back pretty-printed
// with a trailing newline. Kept private to this module — settings.js has a
// superficially similar but different shape (TOML, seeding writes) on purpose.
function jsonStore(filename, rootKey) {
  const file = path.join(__dirname, "..", filename);
  return {
    load() {
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        return d && typeof d === "object" && d[rootKey] ? d[rootKey] : {};
      } catch {
        return {};
      }
    },
    save(data) {
      fs.writeFileSync(file, JSON.stringify({ [rootKey]: data }, null, 2) + "\n");
    },
  };
}

// Local-only "ignore" classification (legacy — migrated into classifications.json
// on first load). Unlike archiving, nothing changes on GitHub.
const ignoredStore = jsonStore("ignored.json", "ignored");

// --- Client-notification records --------------------------------------------
// Tracks WHEN we emailed a client about a repo and WHICH advisories (GHSA IDs)
// we cited, so a later scan can detect new advisories and flag re-contact.
const notifStore = jsonStore("notifications.json", "notifications");

function setNotified(name, ghsas, meta = {}) {
  const data = notifStore.load();
  data[name] = { notifiedAt: new Date().toISOString(), ghsas: [...new Set(ghsas || [])], ...meta };
  notifStore.save(data);
  return data[name];
}

function clearNotified(name) {
  const data = notifStore.load();
  delete data[name];
  notifStore.save(data);
  return data;
}

// --- Engagement classification ---------------------------------------------
// Each repo is maintained (active client / we host), monitored (inactive client
// we watch & notify), or ignored (hidden here). Absence = untriaged. Migrates
// the legacy ignored.json on first load.
// NOTE: VALID mirrors ENGAGEMENTS in public/app.js (the /api/classify contract).

const classStore = jsonStore("classifications.json", "classifications");
const VALID = new Set(["maintained", "monitored", "ignored"]);

function loadClassifications() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "classifications.json"), "utf8"));
    return d && d.classifications ? d.classifications : {};
  } catch {
    const legacy = ignoredStore.load(); // legacy ignored.json: { repo: { at } }
    const migrated = {};
    for (const name of Object.keys(legacy)) {
      migrated[name] = { state: "ignored", at: legacy[name].at || new Date().toISOString() };
    }
    if (Object.keys(migrated).length) {
      try { classStore.save(migrated); } catch {}
    }
    return migrated;
  }
}

/** Map of repo -> "maintained" | "monitored" | "ignored" (untriaged repos absent). */
function classificationMap() {
  const d = loadClassifications();
  const out = {};
  for (const k of Object.keys(d)) out[k] = d[k].state;
  return out;
}

/** Set (or clear → untriaged) a repo's classification. */
function setClassification(name, state) {
  const d = loadClassifications();
  if (!state || !VALID.has(state)) delete d[name];
  else d[name] = { state, at: new Date().toISOString() };
  classStore.save(d);
  return d[name] ? d[name].state : null;
}

// --- Per-repo client contact ------------------------------------------------
const contactStore = jsonStore("contacts.json", "contacts");

function contactsMap() {
  const d = contactStore.load();
  const out = {};
  for (const k of Object.keys(d)) out[k] = { name: d[k].name || "", email: d[k].email || "" };
  return out;
}

function setContact(name, contact) {
  const d = contactStore.load();
  const clean = { name: String((contact && contact.name) || "").trim(), email: String((contact && contact.email) || "").trim() };
  if (!clean.name && !clean.email) delete d[name];
  else d[name] = { ...clean, at: new Date().toISOString() };
  contactStore.save(d);
  return d[name] ? { name: d[name].name, email: d[name].email } : null;
}

// --- CI auto-fix attempt tracking -------------------------------------------
// Records how many headless Claude fix-sessions we've launched per repo+commit,
// so the poller never re-fixes a commit it already tried (and can't loop). Keyed
// by `repo@sha`; persisted so the cap survives a server restart.
const fixStore = jsonStore("fix-attempts.json", "attempts");

function fixAttemptCount(repo, sha) {
  if (!sha) return 0;
  return fixStore.load()[`${repo}@${sha}`] || 0;
}

// Total fix sessions for a repo across ALL commits — bounds a runaway chain where
// each fix pushes a new commit that also fails (each new SHA otherwise gets a fresh
// per-SHA budget). Repo names contain no "@", so the prefix match is unambiguous.
function fixTotalForRepo(repo) {
  const d = fixStore.load();
  let total = 0;
  for (const k of Object.keys(d)) if (k.startsWith(`${repo}@`)) total += d[k];
  return total;
}

function recordFixAttempt(repo, sha) {
  const d = fixStore.load();
  const k = `${repo}@${sha}`;
  d[k] = (d[k] || 0) + 1;
  fixStore.save(d);
  return d[k];
}

// --- Runtime-upgrade dedup --------------------------------------------------
// One auto-opened upgrade PR per repo+runtime+target version; persisted so a
// restart doesn't re-open it. Keyed `repo@id@toVersion`.
const upgradeStore = jsonStore("upgrade-attempts.json", "upgrades");

function upgradeAttempted(repo, id, to) {
  return !!upgradeStore.load()[`${repo}@${id}@${to}`];
}

function recordUpgrade(repo, id, to) {
  const d = upgradeStore.load();
  d[`${repo}@${id}@${to}`] = new Date().toISOString();
  upgradeStore.save(d);
}

// --- SOC 2 compliance scope --------------------------------------------------
// A complete, auditable inventory decision for EVERY org repo: is it subject to
// SOC 2 controls (needs-compliance) or out-of-scope? Separate from the dependency
// classification (a repo can be dependency-ignored yet still need branch protection).
// Absent = undecided (not yet triaged). Persisted as the audit record.
const complianceStore = jsonStore("compliance.json", "compliance");
const COMPLIANCE_STATES = new Set(["needs-compliance", "out-of-scope"]);

function complianceMap() {
  const d = complianceStore.load();
  const out = {};
  for (const k of Object.keys(d)) out[k] = d[k].state;
  return out;
}

function setCompliance(name, state) {
  const d = complianceStore.load();
  if (!state || !COMPLIANCE_STATES.has(state)) delete d[name];
  else d[name] = { state, at: new Date().toISOString() };
  complianceStore.save(d);
  return d[name] ? d[name].state : null;
}

// Write many repo→state entries at once (used for seeding + bulk triage). Only
// valid states are written; a falsy/invalid state clears the entry.
function setComplianceEntries(entries) {
  const d = complianceStore.load();
  const at = new Date().toISOString();
  let n = 0;
  for (const [name, state] of Object.entries(entries || {})) {
    if (!state || !COMPLIANCE_STATES.has(state)) delete d[name];
    else d[name] = { state, at };
    n++;
  }
  complianceStore.save(d);
  return n;
}

// --- SOC 2 scope override ----------------------------------------------------
// Scope is normally DERIVED from engagement (maintained = in scope, else out).
// This store records only the EXCEPTIONS: a repo whose audit scope is deliberately
// forced to differ from that default (e.g. an internal/OSS gem you maintain but that
// sits outside the customer SOC 2 boundary), with a reason. Absent = use the derived value.
const scopeStore = jsonStore("scope-overrides.json", "overrides");
const SCOPE_VALUES = new Set(["in", "out"]);

/** Set (or clear, with a falsy scope) a repo's scope override. Returns the entry or null. */
function setScopeOverride(name, scope, reason) {
  const d = scopeStore.load();
  if (!scope || !SCOPE_VALUES.has(scope)) delete d[name];
  else d[name] = { scope, reason: (reason || "").toString().trim() || null, at: new Date().toISOString() };
  scopeStore.save(d);
  return d[name] || null;
}

// --- Constraint-bump attempt dedup ------------------------------------------
// One auto-opened constraint-bump PR per repo per advisory-signature, so the
// auto-bump never re-fires for the same blocked set (a new advisory set, with a
// different signature, is allowed to trigger a fresh attempt).
const bumpStore = jsonStore("bump-attempts.json", "bumps");

function bumpAttempted(repo, sig) {
  return !!bumpStore.load()[`${repo}@${sig}`];
}

function recordBump(repo, sig) {
  const d = bumpStore.load();
  d[`${repo}@${sig}`] = new Date().toISOString();
  bumpStore.save(d);
}

// --- Gem disposition (covered vs constraint-blocked) ------------------------
// A library (gem) can't be meaningfully lockfile-patched: its remediation is
// either "constraints already permit the patch" (covered → no action; fixed in
// consumers) or "a constraint blocks it" (blocked → gemspec bump). We compute this
// during an update run and cache it here, keyed by repo, alongside a signature of
// the flagged advisory set so a stored verdict self-invalidates when alerts change.
const dispStore = jsonStore("dispositions.json", "dispositions");

// Stable fingerprint of a repo's flagged rubygems advisories (pkg@patched). A
// cached disposition is trusted only while this matches the live advisory set.
function dispositionSig(packages) {
  const keys = (packages || [])
    .filter((p) => p.ecosystem === "rubygems")
    .map((p) => `${p.pkg}@${p.patched || "?"}`);
  return [...new Set(keys)].sort().join(",");
}

function recordDisposition(repo, disp) {
  const d = dispStore.load();
  d[repo] = { ...disp, at: new Date().toISOString() };
  dispStore.save(d);
  return d[repo];
}

function clearDisposition(repo) {
  const d = dispStore.load();
  if (!(repo in d)) return;
  delete d[repo];
  dispStore.save(d);
}

// --- Blocked advisories (lockfile update couldn't reach the patched floor) --
// An app's update run can leave a flagged package below its patched floor because a
// Gemfile/package.json or parent-dependency constraint caps it (same-major fixes
// only — major-only advisories get the holdback table instead). Cache the survivors
// so the card surfaces them on the next reload, keyed by repo alongside a signature
// of the flagged advisory set so a stored list self-invalidates when alerts change.
const blockedStore = jsonStore("blocked.json", "blocked");

// Fingerprint of ALL flagged advisories (any ecosystem), pkg@patched — a cached
// blocked list is trusted only while this matches the live advisory set.
function blockedSig(packages) {
  const keys = (packages || []).map((p) => `${p.ecosystem}:${p.pkg}@${p.patched || "?"}`);
  return [...new Set(keys)].sort().join(",");
}

// Store the survivors (or clear when none remain — a later run that fixes them all
// must not leave a stale list behind). Returns the stored entry, or null when cleared.
function recordBlocked(repo, blocked, sig) {
  const d = blockedStore.load();
  if (!blocked || !blocked.length) delete d[repo];
  else d[repo] = { blocked, sig, at: new Date().toISOString() };
  blockedStore.save(d);
  return d[repo] || null;
}

// --- Dependabot alert dismissals (local audit mirror) -----------------------
// When we dismiss a repo's "covered upstream" alerts on GitHub, we also record it
// here so the dashboard has its own SOC 2 evidence trail (who/when/why/how-many),
// independent of GitHub's record.
const dismissStore = jsonStore("dismissals.json", "dismissals");

function recordDismissal(repo, meta) {
  const d = dismissStore.load();
  d[repo] = { at: new Date().toISOString(), ...meta };
  dismissStore.save(d);
  return d[repo];
}

// --- Engagement change log (SOC 2 audit trail) ------------------------------
// Every classification change appends a timestamped, *noted* entry here — the
// record of WHEN our responsibility for a repo changed and WHY (e.g. a SOW
// ending). Separate from classifications.json (which holds only the CURRENT
// state) so the full history is preserved and auditable.
const engagementStore = jsonStore("engagement-log.json", "log");

/** Append one transition entry { at, from, to, note, sowEndDate } for a repo. */
function appendEngagement(repo, entry) {
  const d = engagementStore.load();
  if (!Array.isArray(d[repo])) d[repo] = [];
  d[repo].push(entry);
  engagementStore.save(d);
  return entry;
}
/** Full chronological history for one repo (oldest first). */
function engagementLogFor(repo) {
  return engagementStore.load()[repo] || [];
}
/** repo -> its most recent engagement entry (for inline display). */
function latestEngagementMap() {
  const d = engagementStore.load();
  const out = {};
  for (const k of Object.keys(d)) {
    const arr = d[k];
    if (arr && arr.length) out[k] = arr[arr.length - 1];
  }
  return out;
}

// Records when we last commented `@dependabot recreate` on a Dependabot PR, keyed
// `repo#prNumber`, so a no-change re-run nudges each PR at most once per day instead
// of spamming a comment every time.
const dependabotNudgeStore = jsonStore("dependabot-nudges.json", "nudges");

/** True if this Dependabot PR was already nudged today (dedupe). */
function dependabotNudgedToday(repo, number) {
  const v = dependabotNudgeStore.load()[`${repo}#${number}`];
  return !!v && String(v).slice(0, 10) === new Date().toISOString().slice(0, 10);
}
/** Record that we nudged this Dependabot PR (timestamped). */
function recordDependabotNudge(repo, number) {
  const d = dependabotNudgeStore.load();
  d[`${repo}#${number}`] = new Date().toISOString();
  dependabotNudgeStore.save(d);
  return d;
}

// --- PR consolidation links (stack / sequence) ------------------------------
// When the user consolidates 2+ conflicting dependency PRs, we record the
// ordering relationship so the dashboard can (a) badge a PR as stacked/sequenced
// in the UI and (b) — for "sequence" — auto-rebase a dependent PR once its blocker
// merges. Keyed by repo → { <prNumber>: { blockedBy, strategy, at } }. A link is
// cleared once acted on (blocker merged → rebase) or when the blocker is gone.
const prLinkStore = jsonStore("pr-links.json", "links");

/** All consolidation links for one repo: { <prNumber>: { blockedBy, strategy, at } }. */
function prLinksFor(repo) {
  return prLinkStore.load()[repo] || {};
}

/** Record that PR `number` is blocked by PR `blockedBy` under `strategy` (stack|sequence). */
function setPrLink(repo, number, blockedBy, strategy) {
  const d = prLinkStore.load();
  const repoLinks = d[repo] || {};
  repoLinks[String(number)] = { blockedBy, strategy, at: new Date().toISOString() };
  d[repo] = repoLinks;
  prLinkStore.save(d);
  return repoLinks[String(number)];
}

/** Drop one PR's link (after its blocker merged & it was rebased, or the blocker vanished). */
function clearPrLink(repo, number) {
  const d = prLinkStore.load();
  if (!d[repo]) return;
  delete d[repo][String(number)];
  if (!Object.keys(d[repo]).length) delete d[repo];
  prLinkStore.save(d);
}

// --- Headless-session logs --------------------------------------------------
// Persisted log of finished sessions per repo, so a run's output is reviewable after it
// completes (and across server restarts). Retention is PR-aware: a session tied to a PR is
// kept until that PR is no longer open (merged/closed); sessions with no PR keep the most
// recent few. A hard per-repo cap is a memory backstop.
const sessionStore = jsonStore("session-history.json", "sessions");
const SESSION_CAP = 50; // backstop per repo

/** Record a finished session for a repo (newest first); returns the repo's list. */
function recordSession(repo, entry) {
  const all = sessionStore.load();
  const arr = all[repo] || [];
  arr.unshift(entry);
  all[repo] = arr.slice(0, SESSION_CAP);
  sessionStore.save(all);
  return all[repo];
}

/** Sessions for one repo, newest first. */
function sessionHistoryFor(repo) {
  return sessionStore.load()[repo] || [];
}

/**
 * Drop sessions whose PR has merged/closed. `openByRepo` maps repo -> Set of OPEN PR
 * numbers (from the current model). A session with a PR number is kept only while that
 * number is still open; a session with no PR keeps the most recent `keepNonPr`. Call this
 * only when the model is reliable (a stale/empty model would prune everything prematurely).
 */
function pruneSessions(openByRepo, keepNonPr = 5) {
  const all = sessionStore.load();
  let changed = false;
  for (const repo of Object.keys(all)) {
    const open = openByRepo[repo] || new Set();
    let nonPr = 0;
    const kept = all[repo].filter((s) => {
      if (s.number == null) { nonPr++; return nonPr <= keepNonPr; }
      return open.has(s.number);
    });
    if (kept.length !== all[repo].length) changed = true;
    if (kept.length) all[repo] = kept; else { delete all[repo]; changed = true; }
  }
  if (changed) sessionStore.save(all);
}

module.exports = {
  recordSession,
  sessionHistoryFor,
  pruneSessions,
  loadClassifications,
  classificationMap,
  setClassification,
  dependabotNudgedToday,
  recordDependabotNudge,
  appendEngagement,
  engagementLogFor,
  latestEngagementMap,
  setScopeOverride,
  scopeOverrideMap: scopeStore.load,
  loadScopeOverrides: scopeStore.load,
  loadNotifications: notifStore.load,
  setNotified,
  clearNotified,
  contactsMap,
  setContact,
  fixAttemptCount,
  fixTotalForRepo,
  recordFixAttempt,
  upgradeAttempted,
  recordUpgrade,
  bumpAttempted,
  recordBump,
  dispositionSig,
  dispositionMap: dispStore.load,
  recordDisposition,
  clearDisposition,
  blockedSig,
  blockedMap: blockedStore.load,
  recordBlocked,
  prLinksFor,
  prLinksMap: prLinkStore.load,
  setPrLink,
  clearPrLink,
  loadDismissals: dismissStore.load,
  recordDismissal,
  loadCompliance: complianceStore.load,
  complianceMap,
  setCompliance,
  setComplianceEntries,
};
