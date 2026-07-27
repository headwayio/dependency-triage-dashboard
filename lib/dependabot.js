"use strict";

// Detect repos where Dependabot's updater is dead in the water — the failure mode that
// looks exactly like "nothing to update".
//
// A dependency pulled straight from a git repo (`gem "x", github: "org/x"`) has to be
// CLONEABLE during resolution. If Dependabot can't reach it, the resolver can't compute
// the dependency graph at all, so EVERY dependency in that project silently stops
// updating — not just the unreachable one. Verified on headwayio/census-sync: one
// unreachable git gem blocked all 28 gems that needed an update and produced zero PRs,
// across security updates too. Nothing surfaces it: the update job still reports
// "success", there's simply no PR and no alert. Same shape of lie as GitHub reporting
// "0 alerts" for an ecosystem it never scanned (see lib/hex.js).
//
// We predict the breakage from the manifests + the org's Dependabot access policy rather
// than scraping updater logs: log inspection needs a per-repo archive download and only
// tells you about runs that already failed, while this flags a repo the moment someone
// adds a private git dep — and names the exact repo to grant.

const { run } = require("./exec");

/** GET JSON via `gh api`; null on any failure (never throws — this is best-effort). */
async function ghApiJson(pathname) {
  try {
    const res = await run("gh", ["api", pathname]);
    return res.code === 0 ? JSON.parse(res.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * The org's Dependabot repository-access policy:
 *   { defaultLevel: "public"|"internal"|..., granted: Set<repoName> }
 * `defaultLevel` is the visibility Dependabot may read WITHOUT an explicit grant;
 * `granted` names the private repos allow-listed on top of it. Returns null when the
 * endpoint is unavailable (older GHES, missing admin:org scope) — callers treat null as
 * "can't tell" and skip the check rather than reporting false breakage.
 */
async function fetchAccess(org) {
  const d = await ghApiJson(`/orgs/${org}/dependabot/repository-access`);
  if (!d || typeof d !== "object") return null;
  const granted = new Set();
  for (const r of d.accessible_repositories || []) {
    const full = r.full_name || r.name || "";
    granted.add(String(full).includes("/") ? full.split("/").pop() : String(full));
  }
  return { defaultLevel: String(d.default_level || "public").toLowerCase(), granted };
}

// Visibility levels Dependabot may read for a given default_level. GitHub widens the
// policy in visibility order, so each level implies the ones below it.
const LEVEL_COVERS = {
  public: new Set(["public"]),
  internal: new Set(["public", "internal"]),
  private: new Set(["public", "internal", "private"]),
  all: new Set(["public", "internal", "private"]),
};

/**
 * Git-sourced dependencies on repos in THIS org, from one manifest.
 *
 * Deliberately NOT parseOrgRefs (which matches any `org/name` substring anywhere in the
 * file): a comment, a source URL, or a homepage would produce false breakage reports. We
 * only want deps whose SOURCE is a git repo, since those are the ones the resolver clones.
 */
function gitSourcedOrgDeps(text, org) {
  if (!text) return [];
  const out = new Set();
  const add = (name) => { if (name) out.add(String(name).replace(/\.git$/, "")); };
  const o = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // org names allow ".", "-"
  // Gemfile / gemspec: `github: "org/repo"`, `git: "https://github.com/org/repo.git"`.
  // Also covers Bundler's `source: "https://github.com/org/repo"`.
  for (const re of [
    new RegExp(`\\bgithub:\\s*["']${o}/([A-Za-z0-9._-]+)["']`, "g"),
    new RegExp(`\\b(?:git|source):\\s*["']https?://(?:www\\.)?github\\.com/${o}/([A-Za-z0-9._-]+?)(?:\\.git)?["']`, "g"),
    new RegExp(`\\b(?:git|source):\\s*["']git@github\\.com:${o}/([A-Za-z0-9._-]+?)(?:\\.git)?["']`, "g"),
    // package.json dependency values: "github:org/repo", "git+https://github.com/org/repo.git",
    // "git+ssh://git@github.com/org/repo.git", and the bare "org/repo#ref" shorthand.
    new RegExp(`["'](?:github:|git\\+https?://(?:www\\.)?github\\.com/|git\\+ssh://git@github\\.com/|git://github\\.com/)${o}/([A-Za-z0-9._-]+?)(?:\\.git)?(?:#[^"']*)?["']`, "g"),
    new RegExp(`["']${o}/([A-Za-z0-9._-]+?)(?:\\.git)?#[^"']*["']`, "g"),
  ]) {
    let m;
    while ((m = re.exec(text))) add(m[1]);
  }
  return [...out];
}

/**
 * Which of `deps` Dependabot cannot clone, given the org policy and a
 * name → visibility map ("public" | "internal" | "private").
 *
 * A dep whose visibility we don't know is treated as REACHABLE. Guessing the other way
 * would flag every repo that depends on an archived or since-deleted gem, and a false
 * "your scanning is broken" is worse than a missed one — it trains you to ignore the badge.
 */
function unreachableDeps(deps, access, visibilityOf) {
  if (!access) return [];
  const covers = LEVEL_COVERS[access.defaultLevel] || LEVEL_COVERS.public;
  return (deps || []).filter((name) => {
    if (access.granted.has(name)) return false;
    const vis = visibilityOf(name);
    if (!vis) return false; // unknown — don't cry wolf
    return !covers.has(String(vis).toLowerCase());
  });
}

/**
 * Per-repo verdict for the UI:
 *   { state: "ok" | "blocked" | "unknown", blockedBy: string[] }
 * "blocked" means every dependency update in this repo is silently failing, so the repo's
 * alert counts and "no updates needed" are both untrustworthy.
 */
function assess(gitDeps, access, visibilityOf) {
  if (!access) return { state: "unknown", blockedBy: [] };
  const blockedBy = unreachableDeps(gitDeps, access, visibilityOf).sort();
  return { state: blockedBy.length ? "blocked" : "ok", blockedBy };
}

// --- "is Dependabot actually doing anything here?" ---------------------------------
//
// Reachability (above) predicts ONE way Dependabot dies. It isn't the only one: a repo
// that hits `open-pull-requests-limit` simply stops running that ecosystem, and GitHub
// pauses schedules for other reasons too. All of them look identical from outside — the
// updater just goes quiet, with no error, no PR, and a green tick on the last job it ran.
//
// So we also check the blunter question: this repo asks for weekly `hex` updates, when did
// a version-update job for `hex` last actually run? That catches every cause at once,
// costs one `gh run list` per repo, and needs no log downloads.

// dependabot.yml names ecosystems differently from the update-job labels. `mix` → `hex`
// is the one that bites (an Elixir repo's runs are titled "hex in /.", never "mix"), but
// npm and gomod are renamed too.
const RUN_LABEL = {
  bundler: "bundler",
  npm: "npm_and_yarn",
  yarn: "npm_and_yarn",
  pnpm: "npm_and_yarn",
  mix: "hex",
  hex: "hex",
  gomod: "go_modules",
  "github-actions": "github_actions",
  pip: "pip",
  uv: "pip",
  composer: "composer",
  cargo: "cargo",
  docker: "docker",
  nuget: "nuget",
  maven: "maven",
  gradle: "gradle",
  swift: "swift",
  terraform: "terraform",
  elm: "elm",
  bun: "bun",
};

// How long after the scheduled interval we call an ecosystem stale. 2× the interval plus
// a day of slack: one missed run is noise (a queue backlog, a re-run), two is a pattern.
const INTERVAL_DAYS = { daily: 1, weekly: 7, monthly: 31 };
function staleAfterDays(interval) {
  return (INTERVAL_DAYS[String(interval || "weekly").toLowerCase()] || 7) * 2 + 1;
}

/**
 * Parse the `updates:` entries out of a dependabot.yml. Deliberately line-based rather
 * than a YAML dependency: we need four scalar fields from a file whose shape is fixed by
 * GitHub's own schema, and the dashboard ships with zero runtime deps.
 * Returns [{ ecosystem, interval, directory, openPrLimit }].
 */
function parseDependabotConfig(text) {
  if (!text) return [];
  const out = [];
  let cur = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*$/, ""); // strip comments
    const eco = line.match(/^\s*-?\s*package-ecosystem:\s*["']?([A-Za-z0-9_-]+)/);
    if (eco) {
      if (cur) out.push(cur);
      cur = { ecosystem: eco[1].toLowerCase(), interval: null, directory: null, openPrLimit: null };
      continue;
    }
    if (!cur) continue;
    const iv = line.match(/^\s*interval:\s*["']?([A-Za-z]+)/);
    if (iv) cur.interval = iv[1].toLowerCase();
    const dir = line.match(/^\s*directory:\s*["']?([^"'\s]+)/);
    if (dir) cur.directory = dir[1];
    const lim = line.match(/^\s*open-pull-requests-limit:\s*([0-9]+)/);
    if (lim) cur.openPrLimit = Number(lim[1]);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Classify one Dependabot updater run from its Actions `displayTitle`.
 *   "hex in /. - Update #1428240213"          → { label: "hex", security: false }
 *   "bundler in /. for nokogiri, loofah"      → { label: "bundler", security: true }
 * Security jobs are alert-driven and keep firing even when the scheduled one has stopped,
 * so counting them as liveness would mask exactly the failure we're looking for.
 */
function classifyRun(displayTitle) {
  const t = String(displayTitle || "");
  const m = t.match(/^([a-z_]+)\s+in\s+/i);
  if (!m) return null;
  return { label: m[1].toLowerCase(), security: / for /.test(t) };
}

/**
 * Which configured ecosystems have gone quiet.
 * @param entries  parseDependabotConfig() output
 * @param runs     [{ displayTitle, createdAt }] — the repo's Dependabot updater runs
 * @param nowMs    clock, injected so this stays a pure function (and testable)
 * @returns [{ ecosystem, label, interval, lastRunAt, ageDays, staleAfterDays }]
 *
 * An ecosystem with NO run at all is reported with lastRunAt null — that's the
 * newly-added-and-never-ran case, which is just as silent as one that stopped.
 */
function staleEcosystems(entries, runs, nowMs) {
  const newest = new Map(); // run label -> newest version-update timestamp
  for (const r of runs || []) {
    const c = classifyRun(r.displayTitle);
    if (!c || c.security) continue;
    const t = Date.parse(r.createdAt || 0) || 0;
    if (!newest.has(c.label) || t > newest.get(c.label)) newest.set(c.label, t);
  }
  const out = [];
  for (const e of entries || []) {
    const label = RUN_LABEL[e.ecosystem];
    if (!label) continue; // ecosystem we don't know the run label for — don't guess
    const limit = staleAfterDays(e.interval);
    const last = newest.get(label) || 0;
    const ageDays = last ? Math.floor((nowMs - last) / 86400000) : null;
    if (last && ageDays <= limit) continue;
    out.push({
      ecosystem: e.ecosystem,
      label,
      interval: e.interval || "weekly",
      lastRunAt: last ? new Date(last).toISOString() : null,
      ageDays,
      staleAfterDays: limit,
    });
  }
  return out;
}

/**
 * The repo's Dependabot updater runs — the Actions runs GitHub creates for each update
 * job, which is the only public record that a job ran at all (there's no REST API for
 * update jobs). Titles carry the ecosystem, so this needs no log downloads.
 * Best-effort: a repo with Actions disabled or no runs yields [].
 */
async function fetchRuns(org, name, limit = 100) {
  const res = await run("gh", [
    "run", "list", "--repo", `${org}/${name}`, "--limit", String(limit),
    "--json", "displayTitle,createdAt,workflowName",
  ]);
  if (res.code !== 0) return [];
  try {
    return (JSON.parse(res.stdout) || []).filter((r) => /epend/i.test(r.workflowName || ""));
  } catch {
    return [];
  }
}

/**
 * Fold the two checks into one per-repo verdict.
 * "blocked" outranks "stale": an unreachable git dep is usually the CAUSE of the silence
 * and names a concrete fix, so leading with "it's been quiet a while" would bury it.
 */
function verdict(reach, stale) {
  const s = stale || [];
  if (reach.state === "blocked") return { state: "blocked", blockedBy: reach.blockedBy, stale: s };
  if (s.length) return { state: "stale", blockedBy: [], stale: s };
  return { state: reach.state, blockedBy: [], stale: [] };
}

module.exports = {
  fetchAccess,
  fetchRuns,
  verdict,
  gitSourcedOrgDeps,
  unreachableDeps,
  assess,
  LEVEL_COVERS,
  parseDependabotConfig,
  classifyRun,
  staleEcosystems,
  staleAfterDays,
  RUN_LABEL,
};
