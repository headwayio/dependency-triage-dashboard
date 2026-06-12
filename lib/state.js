"use strict";

// Local-only "ignore" classification, persisted to ignored.json at the project
// root. Ignored repos are out of SOC 2 maintenance scope but, unlike archiving,
// nothing changes on GitHub — it's purely our triage decision. The file is
// human-readable and safe to commit as an audit record of scope decisions.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "ignored.json");

function loadRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return data && typeof data === "object" && data.ignored ? data.ignored : {};
  } catch {
    return {};
  }
}

/** Set of repo names currently ignored. */
function ignoredSet() {
  return new Set(Object.keys(loadRaw()));
}

/** Toggle a repo's ignored state; returns the new ignored map. */
function setIgnored(name, ignored, meta = {}) {
  const data = loadRaw();
  if (ignored) data[name] = { at: new Date().toISOString(), ...meta };
  else delete data[name];
  fs.writeFileSync(FILE, JSON.stringify({ ignored: data }, null, 2) + "\n");
  return data;
}

// --- Client-notification records --------------------------------------------
// Tracks WHEN we emailed a client about a repo and WHICH advisories (GHSA IDs)
// we cited, so a later scan can detect new advisories and flag re-contact.

const NOTIF_FILE = path.join(__dirname, "..", "notifications.json");

function loadNotifications() {
  try {
    const data = JSON.parse(fs.readFileSync(NOTIF_FILE, "utf8"));
    return data && data.notifications ? data.notifications : {};
  } catch {
    return {};
  }
}

function setNotified(name, ghsas, meta = {}) {
  const data = loadNotifications();
  data[name] = { notifiedAt: new Date().toISOString(), ghsas: [...new Set(ghsas || [])], ...meta };
  fs.writeFileSync(NOTIF_FILE, JSON.stringify({ notifications: data }, null, 2) + "\n");
  return data[name];
}

function clearNotified(name) {
  const data = loadNotifications();
  delete data[name];
  fs.writeFileSync(NOTIF_FILE, JSON.stringify({ notifications: data }, null, 2) + "\n");
  return data;
}

// --- Engagement classification ---------------------------------------------
// Each repo is maintained (active client / we host), monitored (inactive client
// we watch & notify), or ignored (hidden here). Absence = untriaged. Migrates
// the legacy ignored.json on first load.

const CLASS_FILE = path.join(__dirname, "..", "classifications.json");
const VALID = new Set(["maintained", "monitored", "ignored"]);

function loadClassifications() {
  try {
    const d = JSON.parse(fs.readFileSync(CLASS_FILE, "utf8"));
    return d && d.classifications ? d.classifications : {};
  } catch {
    const legacy = loadRaw(); // legacy ignored.json: { repo: { at } }
    const migrated = {};
    for (const name of Object.keys(legacy)) {
      migrated[name] = { state: "ignored", at: legacy[name].at || new Date().toISOString() };
    }
    if (Object.keys(migrated).length) {
      try {
        fs.writeFileSync(CLASS_FILE, JSON.stringify({ classifications: migrated }, null, 2) + "\n");
      } catch {}
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
  fs.writeFileSync(CLASS_FILE, JSON.stringify({ classifications: d }, null, 2) + "\n");
  return d[name] ? d[name].state : null;
}

// --- Per-repo client contact ------------------------------------------------
const CONTACT_FILE = path.join(__dirname, "..", "contacts.json");

function loadContacts() {
  try {
    const d = JSON.parse(fs.readFileSync(CONTACT_FILE, "utf8"));
    return d && d.contacts ? d.contacts : {};
  } catch {
    return {};
  }
}

function contactsMap() {
  const d = loadContacts();
  const out = {};
  for (const k of Object.keys(d)) out[k] = { name: d[k].name || "", email: d[k].email || "" };
  return out;
}

function setContact(name, contact) {
  const d = loadContacts();
  const clean = { name: String((contact && contact.name) || "").trim(), email: String((contact && contact.email) || "").trim() };
  if (!clean.name && !clean.email) delete d[name];
  else d[name] = { ...clean, at: new Date().toISOString() };
  fs.writeFileSync(CONTACT_FILE, JSON.stringify({ contacts: d }, null, 2) + "\n");
  return d[name] ? { name: d[name].name, email: d[name].email } : null;
}

// --- CI auto-fix attempt tracking -------------------------------------------
// Records how many headless Claude fix-sessions we've launched per repo+commit,
// so the poller never re-fixes a commit it already tried (and can't loop). Keyed
// by `repo@sha`; persisted so the cap survives a server restart.
const FIX_FILE = path.join(__dirname, "..", "fix-attempts.json");

function loadFixAttempts() {
  try {
    const d = JSON.parse(fs.readFileSync(FIX_FILE, "utf8"));
    return d && d.attempts ? d.attempts : {};
  } catch {
    return {};
  }
}

function fixAttemptCount(repo, sha) {
  if (!sha) return 0;
  return loadFixAttempts()[`${repo}@${sha}`] || 0;
}

// Total fix sessions for a repo across ALL commits — bounds a runaway chain where
// each fix pushes a new commit that also fails (each new SHA otherwise gets a fresh
// per-SHA budget). Repo names contain no "@", so the prefix match is unambiguous.
function fixTotalForRepo(repo) {
  const d = loadFixAttempts();
  let total = 0;
  for (const k of Object.keys(d)) if (k.startsWith(`${repo}@`)) total += d[k];
  return total;
}

function recordFixAttempt(repo, sha) {
  const d = loadFixAttempts();
  const k = `${repo}@${sha}`;
  d[k] = (d[k] || 0) + 1;
  fs.writeFileSync(FIX_FILE, JSON.stringify({ attempts: d }, null, 2) + "\n");
  return d[k];
}

// --- Runtime-upgrade dedup --------------------------------------------------
// One auto-opened upgrade PR per repo+runtime+target version; persisted so a
// restart doesn't re-open it. Keyed `repo@id@toVersion`.
const UPGRADE_FILE = path.join(__dirname, "..", "upgrade-attempts.json");

function loadUpgrades() {
  try {
    const d = JSON.parse(fs.readFileSync(UPGRADE_FILE, "utf8"));
    return d && d.upgrades ? d.upgrades : {};
  } catch {
    return {};
  }
}

function upgradeAttempted(repo, id, to) {
  return !!loadUpgrades()[`${repo}@${id}@${to}`];
}

function recordUpgrade(repo, id, to) {
  const d = loadUpgrades();
  d[`${repo}@${id}@${to}`] = new Date().toISOString();
  fs.writeFileSync(UPGRADE_FILE, JSON.stringify({ upgrades: d }, null, 2) + "\n");
}

// --- SOC 2 compliance scope --------------------------------------------------
// A complete, auditable inventory decision for EVERY org repo: is it subject to
// SOC 2 controls (needs-compliance) or out-of-scope? Separate from the dependency
// classification (a repo can be dependency-ignored yet still need branch protection).
// Absent = undecided (not yet triaged). Persisted as the audit record.
const COMPLIANCE_FILE = path.join(__dirname, "..", "compliance.json");
const COMPLIANCE_STATES = new Set(["needs-compliance", "out-of-scope"]);

function loadCompliance() {
  try {
    const d = JSON.parse(fs.readFileSync(COMPLIANCE_FILE, "utf8"));
    return d && d.compliance ? d.compliance : {};
  } catch {
    return {};
  }
}

function complianceMap() {
  const d = loadCompliance();
  const out = {};
  for (const k of Object.keys(d)) out[k] = d[k].state;
  return out;
}

function setCompliance(name, state) {
  const d = loadCompliance();
  if (!state || !COMPLIANCE_STATES.has(state)) delete d[name];
  else d[name] = { state, at: new Date().toISOString() };
  fs.writeFileSync(COMPLIANCE_FILE, JSON.stringify({ compliance: d }, null, 2) + "\n");
  return d[name] ? d[name].state : null;
}

// Write many repo→state entries at once (used for seeding + bulk triage). Only
// valid states are written; a falsy/invalid state clears the entry.
function setComplianceEntries(entries) {
  const d = loadCompliance();
  const at = new Date().toISOString();
  let n = 0;
  for (const [name, state] of Object.entries(entries || {})) {
    if (!state || !COMPLIANCE_STATES.has(state)) delete d[name];
    else d[name] = { state, at };
    n++;
  }
  fs.writeFileSync(COMPLIANCE_FILE, JSON.stringify({ compliance: d }, null, 2) + "\n");
  return n;
}

// --- SOC 2 scope override ----------------------------------------------------
// Scope is normally DERIVED from engagement (maintained = in scope, else out).
// This store records only the EXCEPTIONS: a repo whose audit scope is deliberately
// forced to differ from that default (e.g. an internal/OSS gem you maintain but that
// sits outside the customer SOC 2 boundary), with a reason. Absent = use the derived value.
const SCOPE_OVERRIDE_FILE = path.join(__dirname, "..", "scope-overrides.json");
const SCOPE_VALUES = new Set(["in", "out"]);

function loadScopeOverrides() {
  try {
    const d = JSON.parse(fs.readFileSync(SCOPE_OVERRIDE_FILE, "utf8"));
    return d && d.overrides ? d.overrides : {};
  } catch {
    return {};
  }
}
/** Set (or clear, with a falsy scope) a repo's scope override. Returns the entry or null. */
function setScopeOverride(name, scope, reason) {
  const d = loadScopeOverrides();
  if (!scope || !SCOPE_VALUES.has(scope)) delete d[name];
  else d[name] = { scope, reason: (reason || "").toString().trim() || null, at: new Date().toISOString() };
  fs.writeFileSync(SCOPE_OVERRIDE_FILE, JSON.stringify({ overrides: d }, null, 2) + "\n");
  return d[name] || null;
}
function scopeOverrideMap() {
  return loadScopeOverrides();
}

// --- Constraint-bump attempt dedup ------------------------------------------
// One auto-opened constraint-bump PR per repo per advisory-signature, so the
// auto-bump never re-fires for the same blocked set (a new advisory set, with a
// different signature, is allowed to trigger a fresh attempt).
const BUMP_FILE = path.join(__dirname, "..", "bump-attempts.json");

function loadBumps() {
  try {
    const d = JSON.parse(fs.readFileSync(BUMP_FILE, "utf8"));
    return d && d.bumps ? d.bumps : {};
  } catch {
    return {};
  }
}

function bumpAttempted(repo, sig) {
  return !!loadBumps()[`${repo}@${sig}`];
}

function recordBump(repo, sig) {
  const d = loadBumps();
  d[`${repo}@${sig}`] = new Date().toISOString();
  fs.writeFileSync(BUMP_FILE, JSON.stringify({ bumps: d }, null, 2) + "\n");
}

// --- Gem disposition (covered vs constraint-blocked) ------------------------
// A library (gem) can't be meaningfully lockfile-patched: its remediation is
// either "constraints already permit the patch" (covered → no action; fixed in
// consumers) or "a constraint blocks it" (blocked → gemspec bump). We compute this
// during an update run and cache it here, keyed by repo, alongside a signature of
// the flagged advisory set so a stored verdict self-invalidates when alerts change.
const DISP_FILE = path.join(__dirname, "..", "dispositions.json");

function loadDispositions() {
  try {
    const d = JSON.parse(fs.readFileSync(DISP_FILE, "utf8"));
    return d && d.dispositions ? d.dispositions : {};
  } catch {
    return {};
  }
}

// Stable fingerprint of a repo's flagged rubygems advisories (pkg@patched). A
// cached disposition is trusted only while this matches the live advisory set.
function dispositionSig(packages) {
  const keys = (packages || [])
    .filter((p) => p.ecosystem === "rubygems")
    .map((p) => `${p.pkg}@${p.patched || "?"}`);
  return [...new Set(keys)].sort().join(",");
}

function dispositionMap() {
  return loadDispositions();
}

function recordDisposition(repo, disp) {
  const d = loadDispositions();
  d[repo] = { ...disp, at: new Date().toISOString() };
  fs.writeFileSync(DISP_FILE, JSON.stringify({ dispositions: d }, null, 2) + "\n");
  return d[repo];
}

function clearDisposition(repo) {
  const d = loadDispositions();
  if (!(repo in d)) return;
  delete d[repo];
  fs.writeFileSync(DISP_FILE, JSON.stringify({ dispositions: d }, null, 2) + "\n");
}

// --- Dependabot alert dismissals (local audit mirror) -----------------------
// When we dismiss a repo's "covered upstream" alerts on GitHub, we also record it
// here so the dashboard has its own SOC 2 evidence trail (who/when/why/how-many),
// independent of GitHub's record.
const DISMISS_FILE = path.join(__dirname, "..", "dismissals.json");

function loadDismissals() {
  try {
    const d = JSON.parse(fs.readFileSync(DISMISS_FILE, "utf8"));
    return d && d.dismissals ? d.dismissals : {};
  } catch {
    return {};
  }
}

function recordDismissal(repo, meta) {
  const d = loadDismissals();
  d[repo] = { at: new Date().toISOString(), ...meta };
  fs.writeFileSync(DISMISS_FILE, JSON.stringify({ dismissals: d }, null, 2) + "\n");
  return d[repo];
}

// --- Engagement change log (SOC 2 audit trail) ------------------------------
// Every classification change appends a timestamped, *noted* entry here — the
// record of WHEN our responsibility for a repo changed and WHY (e.g. a SOW
// ending). Separate from classifications.json (which holds only the CURRENT
// state) so the full history is preserved and auditable.
const ENGAGEMENT_FILE = path.join(__dirname, "..", "engagement-log.json");

function loadEngagementLog() {
  try {
    const data = JSON.parse(fs.readFileSync(ENGAGEMENT_FILE, "utf8"));
    return data && typeof data === "object" && data.log ? data.log : {};
  } catch {
    return {};
  }
}
/** Append one transition entry { at, from, to, note, sowEndDate } for a repo. */
function appendEngagement(repo, entry) {
  const d = loadEngagementLog();
  if (!Array.isArray(d[repo])) d[repo] = [];
  d[repo].push(entry);
  fs.writeFileSync(ENGAGEMENT_FILE, JSON.stringify({ log: d }, null, 2) + "\n");
  return entry;
}
/** Full chronological history for one repo (oldest first). */
function engagementLogFor(repo) {
  return loadEngagementLog()[repo] || [];
}
/** repo -> its most recent engagement entry (for inline display). */
function latestEngagementMap() {
  const d = loadEngagementLog();
  const out = {};
  for (const k of Object.keys(d)) {
    const arr = d[k];
    if (arr && arr.length) out[k] = arr[arr.length - 1];
  }
  return out;
}

module.exports = {
  loadClassifications,
  classificationMap,
  setClassification,
  appendEngagement,
  engagementLogFor,
  latestEngagementMap,
  setScopeOverride,
  scopeOverrideMap,
  loadScopeOverrides,
  loadNotifications,
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
  dispositionMap,
  recordDisposition,
  clearDisposition,
  loadDismissals,
  recordDismissal,
  loadCompliance,
  complianceMap,
  setCompliance,
  setComplianceEntries,
};
