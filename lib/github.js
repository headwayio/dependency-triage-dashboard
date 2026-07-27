"use strict";

const { run, runOrThrow } = require("./exec");
const state = require("./state");
const hex = require("./hex");
const dependabot = require("./dependabot");

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
  ".[] | . as $a | {" +
  "repo: .repository.full_name, repoName: .repository.name, " +
  "severity: .security_advisory.severity, ecosystem: .dependency.package.ecosystem, " +
  "pkg: .dependency.package.name, patched: .security_vulnerability.first_patched_version.identifier, " +
  // every patched version this advisory lists for the package (across its affected
  // ranges) — lets us prefer a same-major fix over crossing a major.
  "patchedVersions: ([$a.security_advisory.vulnerabilities[]? | select(.package.name == $a.dependency.package.name) | .first_patched_version.identifier] | map(select(. != null))), " +
  "manifest: .dependency.manifest_path, ghsa: .security_advisory.ghsa_id, " +
  "summary: .security_advisory.summary, url: .html_url}";

// ---- version helpers (shared with the updater) -----------------------------
function majorOf(v) {
  const m = /^(\d+)(?:\.|$)/.exec(String(v == null ? "" : v).trim());
  return m ? Number(m[1]) : null;
}
/** Compare dotted numeric versions: <0/0/>0, or null if either has a non-numeric segment. */
function cmpVer(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    if (!/^\d+$/.test(sa) || !/^\d+$/.test(sb)) return null;
    const x = Number(sa);
    const y = Number(sb);
    if (x !== y) return x - y;
  }
  return 0;
}
/** major | minor | patch | "" (can't tell) for from→to. */
function bumpType(from, to) {
  if (!from || !to) return "";
  if (majorOf(from) === null || majorOf(to) === null) return "";
  if (majorOf(to) !== majorOf(from)) return "major";
  const minorOf = (v) => (/^\d+$/.test(String(v).split(".")[1] || "") ? Number(String(v).split(".")[1]) : 0);
  if (minorOf(to) !== minorOf(from)) return "minor";
  return String(from) !== String(to) ? "patch" : "";
}
/**
 * Decide the update target + whether a major is forced. GitHub's `patched`
 * (security_vulnerability.first_patched_version) is the floor for the INSTALLED
 * version's specific affected range. We prefer to stay on the current major: if
 * the range floor crosses a major BUT the advisory also lists a same-major patched
 * version that moves us forward, we target that instead — so a same-major fix is
 * never skipped in favor of a breaking major.
 *  - target major == installed major → a same-major fix exists (majorRequired=false)
 *  - target major  > installed major → the current major has no fix; only a major
 *    upgrade resolves it (majorRequired=true) — the user must opt in.
 * Returns { target, majorRequired, bump }. installed unknown → can't classify.
 */
function chooseTarget(p, installed) {
  const floor = p.patched || null;
  if (!installed || !floor) return { target: floor, majorRequired: false, bump: "" };
  const im = majorOf(installed);
  const fm = majorOf(floor);
  let target = floor;
  // Only second-guess the range floor when it would cross a major: look for a
  // same-major patched version (from any of the advisory's affected ranges) that
  // is strictly newer than what's installed, and prefer the smallest such.
  if (im != null && fm != null && fm > im) {
    const sameMajor = (p.patchedVersions || [])
      .filter((v) => majorOf(v) === im && (cmpVer(installed, v) ?? 1) < 0)
      .sort((a, b) => cmpVer(a, b) ?? 0)[0];
    if (sameMajor) target = sameMajor;
  }
  const tm = majorOf(target);
  const majorRequired = im != null && tm != null && tm > im;
  return { target, majorRequired, bump: bumpType(installed, target) };
}
/** Annotate each flagged package in place with installed/target/bump/majorRequired. */
function annotatePackages(packages, installedMap) {
  for (const p of packages || []) {
    const installed = (installedMap && installedMap[p.pkg]) || null;
    const { target, majorRequired, bump } = chooseTarget(p, installed);
    p.installed = installed;
    p.target = target;
    p.bump = bump;
    p.majorRequired = majorRequired;
  }
}

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
      patchedVersions: a.patchedVersions || [],
      manifest: a.manifest || null,
      ghsa: a.ghsa || null,
      summary: a.summary || "",
      url: a.url || null,
    });
  }
  return alerts;
}

/**
 * Open Dependabot alerts for ONE repo (the per-repo endpoint). Same shape as
 * fetchAlerts minus the repo fields (the caller already knows the repo). Used by
 * refreshRepoModel so "Re-run update" works on fresh data without a full Refresh.
 */
async function fetchRepoAlerts(org, name, state = "open") {
  const res = await runOrThrow("gh", [
    "api",
    "--paginate",
    `/repos/${org}/${name}/dependabot/alerts?state=${encodeURIComponent(state)}&per_page=100`,
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
      continue;
    }
    alerts.push({
      severity: a.severity || "unknown",
      ecosystem: a.ecosystem || "unknown",
      pkg: a.pkg || "unknown",
      patched: a.patched || null,
      patchedVersions: a.patchedVersions || [],
      manifest: a.manifest || null,
      ghsa: a.ghsa || null,
      summary: a.summary || "",
      url: a.url || null,
    });
  }
  return alerts;
}

/**
 * Re-fetch a single repo's open alerts + live tool PRs and update the model object
 * IN PLACE — so "Re-run update" operates on current data (new advisories appear,
 * fixed ones drop) and an externally merged/closed PR is reconciled out of the
 * Pending view without a full org Refresh. Mutates: packages, counts, ecosystems,
 * openPRs, pending, disposition. Leaves local-state fields (classification, contact)
 * untouched. Throws on API failure; callers treat it as best-effort.
 */
async function refreshRepoModel(config, repo) {
  const { org } = config;
  const [alerts, prMap, installed, hexAlerts] = await Promise.all([
    fetchRepoAlerts(org, repo.name, config.alertState || "open"),
    fetchToolPRs(org, [repo.name], config.branchPrefix),
    fetchInstalledVersions(org, repo.name).catch(() => ({})),
    config.hexScan === false ? Promise.resolve([]) : scanRepoHexAlerts(org, repo.name).catch(() => []),
  ]);

  // Rebuild the flagged-package set + counts exactly like buildModel does. Hex
  // advisories (synthesized from mix.lock, since the Dependabot feed omits them)
  // are folded in alongside the Dependabot alerts — same shape, same dedup.
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  const ecosystems = {};
  const packages = [];
  const seen = new Set();
  for (const a of [...alerts, ...hexAlerts]) {
    if (counts[a.severity] !== undefined) counts[a.severity] += 1;
    counts.total += 1;
    ecosystems[a.ecosystem] = (ecosystems[a.ecosystem] || 0) + 1;
    const key = `${a.ecosystem}::${a.pkg}::${a.ghsa}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({
      pkg: a.pkg, ecosystem: a.ecosystem, severity: a.severity, patched: a.patched,
      patchedVersions: a.patchedVersions || [],
      manifest: a.manifest, ghsa: a.ghsa, summary: a.summary, url: a.url,
    });
  }
  packages.sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9));

  annotatePackages(packages, installed); // installed/target/bump/major-required
  repo.counts = counts;
  repo.ecosystems = ecosystems;
  repo.packages = packages;
  // Live tool PRs only — a merged/closed PR is gone from this list, so it drops
  // out of Pending. (fetchToolPRs lists `--state open`.)
  repo.openPRs = prMap[repo.name] || [];
  repo.pending = repo.openPRs.length > 0;
  if (repo.openPRs.length) repo.suggestedReviewer = await fetchSuggestedReviewer(config.org, `${config.org}/${repo.name}`);
  // Re-evaluate the gem disposition against the fresh advisory set.
  const disp = state.dispositionMap()[repo.name];
  repo.disposition = disp && disp.sig === state.dispositionSig(packages) ? disp : null;
  // Re-attach the last run's blocked survivors while the advisory set is unchanged.
  const blk = state.blockedMap()[repo.name];
  repo.blocked = blk && blk.sig === state.blockedSig(packages) ? blk.blocked : null;
  return repo;
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

/** Get-or-create a repo entry in the model map, seeded from authoritative metadata. */
function ensureRepoEntry(repos, repoName, repoMeta, org) {
  if (!repos.has(repoName)) {
    const meta = repoMeta.get(repoName) || {};
    repos.set(repoName, {
      name: repoName,
      nameWithOwner: meta.nameWithOwner || `${org}/${repoName}`,
      url: meta.url || `https://github.com/${org}/${repoName}`,
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
  return repos.get(repoName);
}

/** Fold one alert (Dependabot OR synthesized Hex) into a repo entry: bump the
 *  severity/ecosystem counts and append the package row, deduped by eco+pkg+advisory. */
function addAlertToRepo(r, a) {
  if (r.counts[a.severity] !== undefined) r.counts[a.severity] += 1;
  r.counts.total += 1;
  r.ecosystems[a.ecosystem] = (r.ecosystems[a.ecosystem] || 0) + 1;
  const key = `${a.ecosystem}::${a.pkg}::${a.ghsa}`;
  if (r._seen.has(key)) return;
  r._seen.add(key);
  r.packages.push({
    pkg: a.pkg,
    ecosystem: a.ecosystem,
    severity: a.severity,
    patched: a.patched,
    patchedVersions: a.patchedVersions || [],
    manifest: a.manifest,
    ghsa: a.ghsa,
    summary: a.summary,
    url: a.url,
  });
}

/**
 * Hex (Elixir) security scan — the data source the Dependabot feed can't provide
 * (GitHub doesn't ingest mix.lock). For each candidate repo, fetch its committed
 * mix.lock and cross-reference installed versions against the ERLANG advisory set,
 * returning { repoName: alert[] } in the same shape the Dependabot path uses. The
 * whole scan is best-effort: an advisory-fetch failure or an unreadable lockfile
 * degrades to "no hex alerts", never breaks a Refresh.
 */
async function scanRepoHexAlerts(org, name, byPkg) {
  if (!byPkg) {
    try {
      byPkg = await hex.fetchErlangAdvisories();
    } catch {
      return []; // advisory DB unreachable — skip hex this run
    }
  }
  const lock = await ghFileRaw(org, name, "mix.lock");
  if (!lock) return []; // no mix.lock → not an Elixir project (or nothing to scan)
  const installed = hex.parseMixLock(lock);
  return Object.keys(installed).length ? hex.matchAdvisories(installed, byPkg) : [];
}

async function scanHexAlerts(org, repoNames) {
  if (!repoNames.length) return {};
  let byPkg;
  try {
    byPkg = await hex.fetchErlangAdvisories();
  } catch {
    return {}; // advisory DB unreachable — skip hex this run
  }
  const out = {};
  await mapLimit(repoNames, 12, async (name) => {
    const alerts = await scanRepoHexAlerts(org, name, byPkg);
    if (alerts.length) out[name] = alerts;
  });
  return out;
}

/** The repos to run the Hex scan over: every Elixir-primary repo, plus any repo that
 *  already surfaced via the Dependabot feed (so a polyglot app — e.g. a JS frontend
 *  with an Elixir backend — is scanned too). Honors include/exclude. A polyglot repo
 *  with neither an Elixir primary language nor any other-ecosystem alert won't be
 *  caught automatically — add it to `includeRepos` to force a scan. */
function hexScanCandidates(repoMeta, alertedNames, { include, exclude }) {
  const out = new Set();
  const allow = (name) => (!include.size || include.has(name)) && !exclude.has(name);
  for (const [name, meta] of repoMeta) {
    if (!meta.archived && meta.language === "Elixir" && allow(name)) out.add(name);
  }
  for (const name of alertedNames) if (allow(name)) out.add(name);
  return [...out];
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
    addAlertToRepo(ensureRepoEntry(repos, a.repoName, repoMeta, org), a);
  }

  // Hex (Elixir) advisories — fetched independently of the Dependabot feed, which
  // is blind to mix.lock. Merge them in BEFORE _seen is dropped so dedup/counts match.
  if (config.hexScan !== false) {
    const hexByRepo = await scanHexAlerts(
      org,
      hexScanCandidates(repoMeta, [...repos.keys()], { include, exclude })
    );
    for (const [name, hexAlerts] of Object.entries(hexByRepo)) {
      const r = ensureRepoEntry(repos, name, repoMeta, org);
      for (const a of hexAlerts) addAlertToRepo(r, a);
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

  // Annotate each flagged package with its installed (default-branch) version, the
  // chosen target (prefer a same-major fix), bump type, and whether a major is forced.
  // Best-effort + concurrency-capped; a fetch failure just leaves the package un-annotated.
  await mapLimit(list, 8, async (r) => {
    try {
      annotatePackages(r.packages, await fetchInstalledVersions(org, r.name));
    } catch {
      annotatePackages(r.packages, {});
    }
  });
  const prMap = await fetchToolPRs(org, list.map((r) => r.name), config.branchPrefix);
  for (const r of list) {
    r.openPRs = prMap[r.name] || [];
    r.pending = r.openPRs.length > 0;
  }
  // For repos with open tool PRs, find the reviewer to default the one-click
  // "Request review" button to (most recent across all PRs, open or closed).
  await mapLimit(list.filter((r) => r.openPRs.length), 8, async (r) => {
    r.suggestedReviewer = await fetchSuggestedReviewer(org, `${org}/${r.name}`);
  });

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
  const blk = state.blockedMap();
  for (const r of list) {
    const d = disp[r.name];
    r.disposition = d && d.sig === state.dispositionSig(r.packages) ? d : null;
    // Blocked survivors from the last update run (any ecosystem), same self-invalidation.
    const b = blk[r.name];
    r.blocked = b && b.sig === state.blockedSig(r.packages) ? b.blocked : null;
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
    r.gitDeps = [];
    r.published = null;
    const listing = await ghJson(["api", `/repos/${org}/${r.name}/contents`]);
    // non-array (empty repo / no default branch) degrades to [] — deliberate
    const files = Array.isArray(listing) ? listing.map((f) => f.name) : [];
    r.isGem = files.some((f) => f.endsWith(".gemspec"));
    const refs = new Set();
    // Deps whose SOURCE is a git repo in this org. Narrower than dependsOnOrg (which
    // matches any org/name mention) because an unreachable one silently kills Dependabot
    // for the WHOLE repo — see lib/dependabot.js — so a false positive is expensive.
    const gitDeps = new Set();
    let pkgName = null;
    if (files.includes("Gemfile")) {
      const g = await ghFileRaw(org, r.name, "Gemfile");
      for (const x of parseOrgRefs(g, org)) refs.add(x);
      for (const x of dependabot.gitSourcedOrgDeps(g, org)) gitDeps.add(x);
    }
    if (files.includes("package.json")) {
      const p = await ghFileRaw(org, r.name, "package.json");
      for (const x of parseOrgRefs(p, org)) refs.add(x);
      for (const x of dependabot.gitSourcedOrgDeps(p, org)) gitDeps.add(x);
      try {
        const j = JSON.parse(p);
        if (j && j.name && !j.private) pkgName = j.name;
      } catch {
        /* unparseable package.json */
      }
    }
    refs.delete(r.name);
    gitDeps.delete(r.name);
    r.dependsOnOrg = [...refs];
    r.gitDeps = [...gitDeps];
    if (r.isGem || pkgName) r.published = await checkPublished(org, r.name, pkgName);
  });
  return repos;
}

/**
 * Open PRs opened by this tool, keyed by repo name. Detected by HEAD-BRANCH prefix
 * (not title) so it catches every PR type the tool opens — dependency updates,
 * runtime upgrades (`runtime-upgrade/…`), gemspec constraint bumps
 * (`gemspec-bump/…`), constraint-unblock PRs (`dependency-unblock/…`), major
 * upgrades (`major-upgrade/…`), and release rollups (`release/deps-…`, which consolidate
 * a stack of approved PRs) — which carry different titles. Per-repo `gh pr list`
 * so we get `headRefName`, which the org-wide `gh search prs` doesn't expose.
 */
// The branch prefixes that mark a PR as one of ours (so we never touch a human's PR).
function toolBranchPrefixes(branchPrefix) {
  return [branchPrefix || "dependency-updates/soc2", "runtime-upgrade/", "gemspec-bump/", "dependency-unblock/", "major-upgrade/", "release/deps-"];
}
function isToolBranch(head, branchPrefix) {
  return toolBranchPrefixes(branchPrefix).some((p) => String(head || "").startsWith(p));
}

// Lockfile basenames across the ecosystems we touch. Two open PRs that both change
// the SAME lockfile on the same base will conflict on merge — the signal the
// consolidation suggestion keys on. (Manifests like package.json can usually
// three-way-merge; the regenerated lockfile is what actually collides.)
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "Gemfile.lock", "composer.lock", "mix.lock", "go.sum", "poetry.lock", "Cargo.lock",
]);

// The lockfile basenames a PR's changed files touch (deduped), from `gh pr … --json files`.
function prLockfiles(files) {
  const out = new Set();
  for (const f of files || []) {
    const base = String(f.path || f.filename || "").split("/").pop();
    if (LOCKFILE_BASENAMES.has(base)) out.add(base);
  }
  return [...out];
}

async function fetchToolPRs(org, names, branchPrefix) {
  const map = {};
  await mapLimit(names || [], 8, async (name) => {
    const prs = (await ghJson([
      "pr", "list", "--repo", `${org}/${name}`, "--state", "open",
      "--json", "number,url,isDraft,createdAt,headRefName,baseRefName,title,reviewDecision,reviewRequests,files",
      "--limit", "50",
    ])) || [];
    for (const pr of prs) {
      if (!isToolBranch(pr.headRefName, branchPrefix)) continue;
      (map[name] = map[name] || []).push({
        number: pr.number,
        url: pr.url,
        draft: pr.isDraft,
        createdAt: pr.createdAt,
        headRefName: pr.headRefName, // lets the client correlate e.g. a runtime-upgrade PR to its EOL badge
        baseRefName: pr.baseRefName || null, // the branch this PR targets — base for conflict/stack detection
        lockfiles: prLockfiles(pr.files), // lockfile basenames this PR changes — the conflict surface
        title: pr.title || "",
        // GitHub review status: "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED" | null,
        // plus the explicitly-requested reviewers (users by login, teams by slug/name).
        reviewDecision: pr.reviewDecision || null,
        reviewers: (pr.reviewRequests || []).map((x) => x.login || x.slug || x.name).filter(Boolean),
      });
    }
  });
  return map;
}

/**
 * The reviewer to default a one-click "Request review" button to: the most recently
 * requested reviewer across this repo's PR history (open OR closed), falling back to
 * whoever last actually reviewed. Lets the dashboard re-request the person you normally
 * ask even when a freshly-opened draft PR carries no reviewer yet. Returns a gh-ready
 * handle (`login` for a user, `org/slug` for a team) plus a display string, or null.
 */
async function fetchSuggestedReviewer(org, nwo) {
  const prs = (await ghJson([
    "pr", "list", "--repo", nwo, "--state", "all", "--limit", "30",
    "--json", "createdAt,reviewRequests,reviews",
  ])) || [];
  // Newest PR first — "most recently created pull request, regardless of open/closed".
  prs.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  for (const pr of prs) {
    for (const x of pr.reviewRequests || []) {
      if (x.login) return { handle: x.login, display: x.login, isTeam: false };
      if (x.slug) return { handle: `${org}/${x.slug}`, display: x.slug, isTeam: true };
    }
    // No pending request on this PR — fall back to the last human who actually reviewed.
    const reviewed = (pr.reviews || []).map((rv) => rv.author && rv.author.login).filter(Boolean);
    if (reviewed.length) {
      const login = reviewed[reviewed.length - 1];
      return { handle: login, display: login, isTeam: false };
    }
  }
  return null;
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
  const [gem, npm, yarn, composer, mix] = await Promise.all([
    ghFileRaw(org, repoName, "Gemfile.lock"),
    ghFileRaw(org, repoName, "package-lock.json"),
    ghFileRaw(org, repoName, "yarn.lock"),
    ghFileRaw(org, repoName, "composer.lock"),
    ghFileRaw(org, repoName, "mix.lock"),
  ]);
  return {
    ...parseGemfileLock(gem),
    ...parsePackageLock(npm),
    ...parseYarnLock(yarn),
    ...parseComposerLock(composer),
    ...hex.parseMixLock(mix),
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
  refreshRepoModel,
  bumpType,
  chooseTarget,
  annotatePackages,
  majorOf,
  archiveRepo,
  unarchiveRepo,
  assertRepoName,
  fetchSuggestedReviewer,
  vulnerablePackagesByEcosystem,
  fetchInstalledVersions,
  listOrgRepos,
  enrichComplianceRepos,
  isToolBranch,
  prLockfiles,
  LOCKFILE_BASENAMES,
  SEVERITY_ORDER,
};
