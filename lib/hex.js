"use strict";

// Hex (Elixir/Erlang) security scanning.
//
// Why this module exists: GitHub's dependency graph does NOT parse `mix.lock`,
// so Hex packages never enter the org's Dependabot alert feed — a repo's "0 hex
// alerts" means UNSCANNED, not clean (the SBOM shows zero hex packages even for a
// large Elixir app). Every other ecosystem in this tool rides the Dependabot feed
// (`lib/github.js:fetchAlerts`); Hex can't, so we scan it ourselves: parse each
// repo's committed `mix.lock`, then cross-reference the installed versions against
// GitHub's Advisory Database under the `ERLANG` ecosystem (the same advisory data
// Dependabot would use — it's just never auto-matched against mix.lock). The result
// is synthesized into the SAME alert shape the Dependabot path produces, so Hex
// repos flow through the existing triage/tabs/update-PR machinery unchanged.

const { run } = require("./exec");

// --- version compare + range matching for Hex (semver-ish: x.y.z[-pre]) ------

function parseV(v) {
  const [core, pre] = String(v).split("-", 2);
  const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre: pre || null };
}

/** <0 / 0 / >0 comparing two Hex versions; a prerelease sorts below its release. */
function cmpVer(a, b) {
  const pa = parseV(a);
  const pb = parseV(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/**
 * Is `version` inside a GitHub `vulnerableVersionRange`? GitHub formats these as a
 * comma-separated conjunction of simple constraints, e.g. ">= 1.4.0, < 1.11.1",
 * "< 1.11.0", or "= 1.2.3". ALL parts must hold. An unparseable part fails closed
 * (treated as "not in range") so we never invent a match.
 */
function inRange(version, range) {
  const parts = String(range).split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^(>=|<=|>|<|=)\s*(.+)$/);
    if (!m) return false;
    const [, op, ver] = m;
    const c = cmpVer(version, ver);
    if (op === ">=" && !(c >= 0)) return false;
    if (op === "<=" && !(c <= 0)) return false;
    if (op === ">" && !(c > 0)) return false;
    if (op === "<" && !(c < 0)) return false;
    if (op === "=" && c !== 0) return false;
  }
  return true;
}

/**
 * Parse a `mix.lock` into { packageName: version }. The format is an Elixir map
 * literal whose every entry looks like:
 *   "bandit": {:hex, :bandit, "1.10.1", "<hash>", [:mix], [<deps>], "hexpm", "<hash>"},
 * We only need the declared name and the resolved version (3rd tuple slot). Non-hex
 * entries (`:git`, `:path`) have no version in that slot and are skipped by the regex.
 */
function parseMixLock(text) {
  const map = {};
  if (!text) return map;
  const re = /"([a-zA-Z0-9_]+)":\s*\{:hex,\s*:[a-zA-Z0-9_]+,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) if (!(m[1] in map)) map[m[1]] = m[2];
  return map;
}

// --- GitHub Advisory Database: the full ERLANG advisory set ------------------
// Cached per-process with a TTL so a Refresh (or the periodic poll) doesn't refetch
// the whole set every time. The set is small (~100 rows) and changes slowly.

const ADVISORY_TTL_MS = 6 * 60 * 60 * 1000; // 6h
let _advisoryCache = null; // { at: epochMs, byPkg: Map<lcName, advisory[]> }

const SEVERITY_MAP = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", LOW: "low" };

/**
 * Pull every ERLANG (Hex) advisory from GitHub's Advisory Database via GraphQL,
 * following cursor pagination. Returns a Map keyed by lowercased package name →
 * array of { range, patched, severity, ghsa, summary }. Cached for ADVISORY_TTL_MS.
 * Throws on a hard GraphQL failure (caller treats the whole hex scan as best-effort).
 */
async function fetchErlangAdvisories({ force = false } = {}) {
  if (!force && _advisoryCache && Date.now() - _advisoryCache.at < ADVISORY_TTL_MS) {
    return _advisoryCache.byPkg;
  }
  const byPkg = new Map();
  let after = "null";
  // Hard cap on pages — a runaway cursor can't loop forever.
  for (let page = 0; page < 50; page++) {
    const query = `query {
      securityVulnerabilities(ecosystem: ERLANG, first: 100, after: ${after}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          package { name }
          vulnerableVersionRange
          firstPatchedVersion { identifier }
          severity
          advisory { ghsaId summary permalink }
        }
      }
    }`;
    const res = await run("gh", ["api", "graphql", "-f", `query=${query}`]);
    if (res.code !== 0) throw new Error(`gh api graphql (ERLANG advisories) failed: ${res.stderr || res.stdout}`);
    let json;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new Error("Unparseable GraphQL response for ERLANG advisories");
    }
    const conn = json?.data?.securityVulnerabilities;
    if (!conn) throw new Error("Unexpected GraphQL shape for ERLANG advisories");
    for (const n of conn.nodes || []) {
      const name = n?.package?.name;
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byPkg.has(key)) byPkg.set(key, []);
      byPkg.get(key).push({
        range: n.vulnerableVersionRange,
        patched: n.firstPatchedVersion?.identifier || null,
        severity: SEVERITY_MAP[n.severity] || "unknown",
        ghsa: n.advisory?.ghsaId || null,
        summary: n.advisory?.summary || "",
        url: n.advisory?.permalink || (n.advisory?.ghsaId ? `https://github.com/advisories/${n.advisory.ghsaId}` : null),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = JSON.stringify(conn.pageInfo.endCursor); // opaque cursor → quote it
  }
  _advisoryCache = { at: Date.now(), byPkg };
  return byPkg;
}

/**
 * Cross-reference one parsed mix.lock against the advisory set, returning one
 * synthesized "alert" per (package, advisory) match — the same shape the Dependabot
 * path yields (severity/ecosystem/pkg/patched/patchedVersions/ghsa/summary/url/manifest),
 * plus `installed` (we already know it from mix.lock). `patchedVersions` collects every
 * patched floor this package's matching advisories list, so chooseTarget can prefer a
 * same-major fix exactly as it does for Dependabot alerts.
 */
function matchAdvisories(installed, byPkg) {
  const alerts = [];
  for (const [name, version] of Object.entries(installed)) {
    const advs = byPkg.get(name.toLowerCase());
    if (!advs) continue;
    const matched = advs.filter((a) => inRange(version, a.range));
    if (!matched.length) continue;
    const patchedVersions = [...new Set(matched.map((a) => a.patched).filter(Boolean))];
    for (const a of matched) {
      alerts.push({
        severity: a.severity,
        ecosystem: "erlang", // GitHub's ecosystem id for Hex — matches byEco grouping in the updater
        pkg: name,
        installed: version,
        patched: a.patched,
        patchedVersions,
        manifest: "mix.lock",
        ghsa: a.ghsa,
        summary: a.summary,
        url: a.url,
      });
    }
  }
  return alerts;
}

module.exports = { cmpVer, inRange, parseMixLock, fetchErlangAdvisories, matchAdvisories, SEVERITY_MAP };
