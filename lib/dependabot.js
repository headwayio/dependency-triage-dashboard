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

module.exports = { fetchAccess, gitSourcedOrgDeps, unreachableDeps, assess, LEVEL_COVERS };
