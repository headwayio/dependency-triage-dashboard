"use strict";

const { run, runOrThrow } = require("./exec");
const state = require("./state");

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sum severity counts across a set of repos. */
function computeTotals(repos) {
  const t = { critical: 0, high: 0, medium: 0, low: 0, total: 0, repos: repos.length };
  for (const r of repos) {
    for (const k of ["critical", "high", "medium", "low", "total"]) t[k] += r.counts[k];
  }
  return t;
}
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/** Reject anything that isn't a bare repo name (no slashes, no shell metachars). */
function assertRepoName(name) {
  if (typeof name !== "string" || !REPO_RE.test(name)) {
    throw new Error(`Invalid repo name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Parsed JSON from a gh command, or null on non-zero exit / unparseable output. */
async function ghJson(args) {
  const res = await run("gh", args);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/** Who is gh authenticated as, and does it work at all. */
async function whoami() {
  const res = await run("gh", ["api", "user", "--jq", ".login"]);
  if (res.code !== 0) {
    throw new Error(
      "gh is not authenticated. Run `gh auth login` first.\n" + (res.stderr || res.stdout)
    );
  }
  return res.stdout.trim();
}

// Projection applied server-side by gh's jq so we transfer ~200KB, not ~27MB.
const ALERT_JQ =
  ".[] | {" +
  "repo: .repository.full_name, repoName: .repository.name, " +
  "severity: .security_advisory.severity, ecosystem: .dependency.package.ecosystem, " +
  "pkg: .dependency.package.name, patched: .security_vulnerability.first_patched_version.identifier, " +
  "manifest: .dependency.manifest_path, ghsa: .security_advisory.ghsa_id, " +
  "summary: .security_advisory.summary, url: .html_url}";

/**
 * Pull every open Dependabot alert for the org. The org endpoint aggregates all
 * repos server-side, so this is the single source of truth.
 *
 * NOTE: this endpoint uses cursor pagination (Link header) and rejects `?page=N`
 * with HTTP 400 — so we rely on `gh api --paginate`, which follows the cursors,
 * and `--jq` to stream one compact JSON object per line (NDJSON).
 */
async function fetchAlerts(org, state = "open") {
  const res = await runOrThrow("gh", [
    "api",
    "--paginate",
    `/orgs/${org}/dependabot/alerts?state=${encodeURIComponent(state)}&per_page=100`,
    "--jq",
    ALERT_JQ,
  ]);
  const alerts = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    let a;
    try {
      a = JSON.parse(line);
    } catch {
      continue; // skip any malformed line rather than failing the whole scan
    }
    alerts.push({
      repo: a.repo,
      repoName: a.repoName,
      severity: a.severity || "unknown",
      ecosystem: a.ecosystem || "unknown",
      pkg: a.pkg || "unknown",
      patched: a.patched || null,
      manifest: a.manifest || null,
      ghsa: a.ghsa || null,
      summary: a.summary || "",
      url: a.url || null,
    });
  }
  return alerts;
}

/** All org repos with the metadata we need to render and to open PRs against. */
async function fetchRepos(org) {
  const res = await runOrThrow("gh", [
    "repo",
    "list",
    org,
    "--limit",
    "1000",
    "--json",
    "name,nameWithOwner,isArchived,isFork,pushedAt,defaultBranchRef,primaryLanguage,description,url,visibility",
  ]);
  const list = JSON.parse(res.stdout);
  const byName = new Map();
  for (const r of list) {
    byName.set(r.name, {
      name: r.name,
      nameWithOwner: r.nameWithOwner,
      archived: !!r.isArchived,
      isFork: !!r.isFork,
      pushedAt: r.pushedAt || null,
      defaultBranch: r.defaultBranchRef?.name || null,
      language: r.primaryLanguage?.name || null,
      description: r.description || "",
      url: r.url,
      visibility: r.visibility,
    });
  }
  return byName;
}

/**
 * Build the per-repo model the dashboard renders: only repos that currently
 * have open alerts, joined with authoritative repo metadata, sorted worst-first.
 */
async function buildModel(config) {
  const { org } = config;
  const include = new Set(config.includeRepos || []);
  const exclude = new Set(config.excludeRepos || []);

  const [alerts, repoMeta] = await Promise.all([
    fetchAlerts(org, config.alertState || "open"),
    fetchRepos(org),
  ]);

  const repos = new Map();
  for (const a of alerts) {
    if (!a.repoName) continue;
    if (include.size && !include.has(a.repoName)) continue;
    if (exclude.has(a.repoName)) continue;

    if (!repos.has(a.repoName)) {
      const meta = repoMeta.get(a.repoName) || {};
      repos.set(a.repoName, {
        name: a.repoName,
        nameWithOwner: a.repo || `${org}/${a.repoName}`,
        url: meta.url || `https://github.com/${org}/${a.repoName}`,
        description: meta.description || "",
        language: meta.language || null,
        visibility: meta.visibility || null,
        archived: !!meta.archived,
        pushedAt: meta.pushedAt || null,
        defaultBranch: meta.defaultBranch || null,
        counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        ecosystems: {},
        packages: [],
        _seen: new Set(),
      });
    }
    const r = repos.get(a.repoName);
    if (r.counts[a.severity] !== undefined) r.counts[a.severity] += 1;
    r.counts.total += 1;
    r.ecosystems[a.ecosystem] = (r.ecosystems[a.ecosystem] || 0) + 1;

    // De-dup the displayed package list by ecosystem+package+advisory.
    const key = `${a.ecosystem}::${a.pkg}::${a.ghsa}`;
    if (!r._seen.has(key)) {
      r._seen.add(key);
      r.packages.push({
        pkg: a.pkg,
        ecosystem: a.ecosystem,
        severity: a.severity,
        patched: a.patched,
        manifest: a.manifest,
        ghsa: a.ghsa,
        summary: a.summary,
        url: a.url,
      });
    }
  }

  const list = [...repos.values()].map((r) => {
    delete r._seen;
    r.packages.sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    );
    return r;
  });

  // Most recently updated first; ties broken by severity, then name.
  list.sort((a, b) => {
    const ta = a.pushedAt ? Date.parse(a.pushedAt) : 0;
    const tb = b.pushedAt ? Date.parse(b.pushedAt) : 0;
    if (tb !== ta) return tb - ta;
    for (const k of ["critical", "high", "medium", "low", "total"]) {
      if (b.counts[k] !== a.counts[k]) return b.counts[k] - a.counts[k];
    }
    return a.name.localeCompare(b.name);
  });

  // Enrich with dependency relationships + open tool PRs (best-effort).
  await enrichDependencies(org, list);
  const prMap = await fetchToolPRs(org, list.map((r) => r.name), config.branchPrefix);
  for (const r of list) {
    r.openPRs = prMap[r.name] || [];
    r.pending = r.openPRs.length > 0;
  }

  // Client-notification state: when we last notified, and whether NEW advisories
  // (GHSA IDs not in the snapshot we emailed about) have appeared since.
  const notifs = state.loadNotifications();
  for (const r of list) {
    const n = notifs[r.name];
    r.notifiedAt = n ? n.notifiedAt : null;
    if (n) {
      const snap = new Set(n.ghsas || []);
      const fresh = new Set();
      for (const p of r.packages || []) if (p.ghsa && !snap.has(p.ghsa)) fresh.add(p.ghsa);
      r.newAdvisoryCount = fresh.size;
    } else {
      r.newAdvisoryCount = 0;
    }
  }

  // Engagement classification (untriaged | maintained | monitored | ignored).
  const cls = state.classificationMap();
  for (const r of list) r.classification = cls[r.name] || "untriaged";

  // Per-repo client contact (for greeting auto-fill + mailto).
  const contacts = state.contactsMap();
  for (const r of list) r.contact = contacts[r.name] || null;

  // Gem disposition (covered = constraints already permit the patches; blocked =
  // a gemspec constraint blocks one). Trusted only while the cached signature still
  // matches the live advisory set — otherwise the repo falls back to Maintained.
  const disp = state.dispositionMap();
  for (const r of list) {
    const d = disp[r.name];
    r.disposition = d && d.sig === state.dispositionSig(r.packages) ? d : null;
  }

  // Headline "to maintain" = what we actually patch: maintained repos plus any
  // repo with an in-flight PR (active remediation). Covered gems need no action,
  // so they're excluded from the count and live in their own resting tab.
  const isCovered = (r) => r.disposition && r.disposition.state === "covered";
  const totals = computeTotals(
    list.filter((r) => !r.archived && ((r.classification === "maintained" && !isCovered(r)) || r.pending))
  );

  return { org, generatedAt: new Date().toISOString(), totals, repos: list };
}

/** Archive a repo on GitHub (reversible — you can unarchive in repo settings). */
async function archiveRepo(org, repoName) {
  assertRepoName(repoName);
  await runOrThrow("gh", [
    "api",
    "-X",
    "PATCH",
    `/repos/${org}/${repoName}`,
    "-F",
    "archived=true",
  ]);
  return { name: repoName, archived: true };
}

async function unarchiveRepo(org, repoName) {
  assertRepoName(repoName);
  await runOrThrow("gh", [
    "api",
    "-X",
    "PATCH",
    `/repos/${org}/${repoName}`,
    "-F",
    "archived=false",
  ]);
  return { name: repoName, archived: false };
}

/** Vulnerable package names for a repo, grouped by ecosystem (for targeted updates). */
function vulnerablePackagesByEcosystem(repo) {
  const out = {};
  for (const p of repo.packages || []) {
    (out[p.ecosystem] = out[p.ecosystem] || new Set()).add(p.pkg);
  }
  const result = {};
  for (const [eco, set] of Object.entries(out)) result[eco] = [...set];
  return result;
}

// --- Dependency-graph + open-PR enrichment ---------------------------------

/** Concurrency-limited async map (avoids spawning N gh processes at once). */
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Raw text of a repo file via gh, or null if it doesn't exist. */
async function ghFileRaw(org, repo, path) {
  const res = await run("gh", [
    "api",
    `/repos/${org}/${repo}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  return res.code === 0 ? res.stdout : null;
}

/** Extract referenced `<org>/<name>` repos from manifest text. */
function parseOrgRefs(text, org) {
  if (!text) return [];
  const refs = new Set();
  const re = new RegExp(`${org}/([A-Za-z0-9._-]+)`, "g");
  let m;
  while ((m = re.exec(text))) refs.add(m[1].replace(/\.git$/, ""));
  return [...refs];
}

/** GET JSON with a short timeout; null on any failure. */
async function fetchJson(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "dependency-dashboard" },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Is this repo a PUBLISHED package whose registry metadata points back to
 * <org>/<repo>? Confirming the GitHub URL avoids false positives from unrelated
 * packages that merely share a name.
 */
async function checkPublished(org, repo, pkgName) {
  const points = (obj) => obj && JSON.stringify(obj).includes(`${org}/${repo}`);
  const rg = await fetchJson(`https://rubygems.org/api/v1/gems/${encodeURIComponent(repo)}.json`);
  if (points(rg)) return { registry: "rubygems", name: rg.name };
  if (pkgName) {
    const np = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    if (points(np)) return { registry: "npm", name: pkgName };
  }
  return null;
}

/**
 * Per repo: which org repos it depends on (Gemfile/package.json), the
 * reverse "depended on by" within the audited set, and whether it's published
 * publicly. Best-effort — failures degrade to empty, never break a scan.
 */
async function enrichDependencies(org, list) {
  const names = new Set(list.map((r) => r.name));
  await mapLimit(list, 8, async (r) => {
    const [gemfile, pkgRaw] = await Promise.all([
      ghFileRaw(org, r.name, "Gemfile"),
      ghFileRaw(org, r.name, "package.json"),
    ]);
    const refs = new Set([...parseOrgRefs(gemfile, org), ...parseOrgRefs(pkgRaw, org)]);
    refs.delete(r.name);
    r.dependsOnOrg = [...refs];
    let pkgName = null;
    if (pkgRaw) {
      try {
        const j = JSON.parse(pkgRaw);
        if (j && j.name && !j.private) pkgName = j.name;
      } catch {}
    }
    r.published = await checkPublished(org, r.name, pkgName);
  });
  const dependents = {};
  for (const r of list) {
    for (const dep of r.dependsOnOrg || []) {
      if (names.has(dep)) (dependents[dep] = dependents[dep] || []).push(r.name);
    }
  }
  for (const r of list) r.dependents = dependents[r.name] || [];
}

// Compliance-inventory enrichment for an arbitrary repo list (the Compliance tab,
// which spans the whole org — not just alerted repos). Per repo, mutates: `isGem`
// (a *.gemspec at the repo root), `published` ({registry,name} via rubygems/npm,
// reusing checkPublished), and `dependsOnOrg` (org repos it depends on, from its
// Gemfile/package.json). The caller inverts dependsOnOrg → "dependents". One root
// contents listing per repo (so we detect the gemspec AND know which manifests
// exist without blind fetches), then only the manifests that are present.
async function enrichComplianceRepos(org, repos) {
  await mapLimit(repos, 16, async (r) => {
    r.isGem = false;
    r.dependsOnOrg = [];
    r.published = null;
    const listing = await ghJson(["api", `/repos/${org}/${r.name}/contents`]);
    // non-array (empty repo / no default branch) degrades to [] — deliberate
    const files = Array.isArray(listing) ? listing.map((f) => f.name) : [];
    r.isGem = files.some((f) => f.endsWith(".gemspec"));
    const refs = new Set();
    let pkgName = null;
    if (files.includes("Gemfile")) {
      for (const x of parseOrgRefs(await ghFileRaw(org, r.name, "Gemfile"), org)) refs.add(x);
    }
    if (files.includes("package.json")) {
      const p = await ghFileRaw(org, r.name, "package.json");
      for (const x of parseOrgRefs(p, org)) refs.add(x);
      try {
        const j = JSON.parse(p);
        if (j && j.name && !j.private) pkgName = j.name;
      } catch {
        /* unparseable package.json */
      }
    }
    refs.delete(r.name);
    r.dependsOnOrg = [...refs];
    if (r.isGem || pkgName) r.published = await checkPublished(org, r.name, pkgName);
  });
  return repos;
}

/**
 * Open PRs opened by this tool, keyed by repo name. Detected by HEAD-BRANCH prefix
 * (not title) so it catches every PR type the tool opens — dependency updates,
 * runtime upgrades (`runtime-upgrade/…`), and gemspec constraint bumps
 * (`gemspec-bump/…`) — which carry different titles. Per-repo `gh pr list` so we get
 * `headRefName`, which the org-wide `gh search prs` doesn't expose.
 */
async function fetchToolPRs(org, names, branchPrefix) {
  const prefixes = [branchPrefix || "dependency-updates/soc2", "runtime-upgrade/", "gemspec-bump/"];
  const isTool = (head) => prefixes.some((p) => String(head || "").startsWith(p));
  const map = {};
  await mapLimit(names || [], 8, async (name) => {
    const prs = (await ghJson([
      "pr", "list", "--repo", `${org}/${name}`, "--state", "open",
      "--json", "number,url,isDraft,createdAt,headRefName,reviewDecision,reviewRequests",
      "--limit", "50",
    ])) || [];
    for (const pr of prs) {
      if (!isTool(pr.headRefName)) continue;
      (map[name] = map[name] || []).push({
        number: pr.number,
        url: pr.url,
        draft: pr.isDraft,
        createdAt: pr.createdAt,
        // GitHub review status: "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED" | null,
        // plus the explicitly-requested reviewers (users by login, teams by slug/name).
        reviewDecision: pr.reviewDecision || null,
        reviewers: (pr.reviewRequests || []).map((x) => x.login || x.slug || x.name).filter(Boolean),
      });
    }
  });
  return map;
}

// --- Installed-version lookup (lockfile parsing) ---------------------------
// Maps package name -> installed version, by fetching & parsing the repo's
// lockfiles. Used to classify each update as major/minor/patch for estimates.

function parseGemfileLock(text) {
  const map = {};
  if (!text) return map;
  const re = /^\s{4}([A-Za-z0-9._-]+) \(([0-9][^)]*)\)/gm;
  let m;
  while ((m = re.exec(text))) if (!(m[1] in map)) map[m[1]] = m[2];
  return map;
}

function parsePackageLock(text) {
  const map = {};
  if (!text) return map;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return map;
  }
  const put = (name, ver) => {
    if (name && ver && !(name in map)) map[name] = ver;
  };
  if (json.packages) {
    for (const [k, v] of Object.entries(json.packages)) {
      const i = k.lastIndexOf("node_modules/");
      if (i === -1) continue;
      put(k.slice(i + "node_modules/".length), v && v.version);
    }
  }
  if (json.dependencies) {
    const walk = (deps) => {
      for (const [name, info] of Object.entries(deps)) {
        if (info && info.version) put(name, info.version);
        if (info && info.dependencies) walk(info.dependencies);
      }
    };
    walk(json.dependencies);
  }
  return map;
}

function parseYarnLock(text) {
  const map = {};
  if (!text) return map;
  for (const block of text.split(/\n\s*\n/)) {
    const vm = block.match(/^\s+version:?\s+"?([^"\n]+)"?/m);
    if (!vm) continue;
    const head = block.split("\n").find((l) => l && !/^\s/.test(l) && !l.startsWith("#"));
    if (!head) continue;
    const spec = head.split(",")[0].trim().replace(/^"/, "").replace(/:$/, "").replace(/"$/, "");
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    if (name && !(name in map)) map[name] = vm[1];
  }
  return map;
}

function parseComposerLock(text) {
  const map = {};
  if (!text) return map;
  try {
    const j = JSON.parse(text);
    for (const p of [...(j.packages || []), ...(j["packages-dev"] || [])]) {
      if (p && p.name) map[p.name] = String(p.version || "").replace(/^v/, "");
    }
  } catch {}
  return map;
}

/** Best-effort installed-version map across a repo's lockfiles. */
async function fetchInstalledVersions(org, repoName) {
  assertRepoName(repoName);
  const [gem, npm, yarn, composer] = await Promise.all([
    ghFileRaw(org, repoName, "Gemfile.lock"),
    ghFileRaw(org, repoName, "package-lock.json"),
    ghFileRaw(org, repoName, "yarn.lock"),
    ghFileRaw(org, repoName, "composer.lock"),
  ]);
  return {
    ...parseGemfileLock(gem),
    ...parsePackageLock(npm),
    ...parseYarnLock(yarn),
    ...parseComposerLock(composer),
  };
}

// Org repos for the SOC 2 compliance inventory (not just repos with open alerts).
// Default: every non-archived repo. `{ archived: true }` lists the archived
// (read-only) set instead — excluded from the active inventory, kept separately
// so they can be audited / unarchived / deleted. One call; lightweight fields only.
async function listOrgRepos(org, { archived = false } = {}) {
  const list = (await ghJson([
    "repo", "list", org,
    archived ? "--archived" : "--no-archived", "--limit", "1000",
    "--json", "name,defaultBranchRef,pushedAt,visibility,isPrivate,url",
  ])) || [];
  return list.map((r) => ({
    name: r.name,
    nameWithOwner: `${org}/${r.name}`,
    url: r.url || `https://github.com/${org}/${r.name}`,
    defaultBranch: (r.defaultBranchRef && r.defaultBranchRef.name) || null,
    pushedAt: r.pushedAt || null,
    visibility: (r.visibility || (r.isPrivate ? "PRIVATE" : "PUBLIC")).toLowerCase(),
  }));
}

module.exports = {
  whoami,
  fetchAlerts,
  fetchRepos,
  buildModel,
  archiveRepo,
  unarchiveRepo,
  assertRepoName,
  vulnerablePackagesByEcosystem,
  fetchInstalledVersions,
  listOrgRepos,
  enrichComplianceRepos,
  SEVERITY_ORDER,
};
