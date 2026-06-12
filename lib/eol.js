"use strict";

// Generic runtime end-of-life detection + upgrade targeting, backed by
// endoflife.date. One code path covers Ruby / Node / Go / PHP (and anything else
// endoflife.date tracks) — the only per-runtime data is the registry below.

const https = require("https");
const fsSync = require("fs");
const path = require("path");
const { run } = require("./exec");

// ---- runtime registry ------------------------------------------------------
// Keyed by the ecosystem name GitHub advisories use (so we can map a repo's
// ecosystems → the runtimes it ships). `pins` = where the version is declared,
// most-authoritative first; each pin also knows how to REWRITE itself for an
// upgrade (used by the upgrade-PR job).
const RUNTIMES = {
  rubygems: {
    id: "ruby",
    slug: "ruby",
    granularity: "patch", // pin/install at x.y.z
    pins: [
      { file: ".ruby-version", re: /([0-9]+\.[0-9]+\.[0-9]+)/, write: (_c, v) => v + "\n" },
      { file: ".tool-versions", re: /^\s*ruby\s+([0-9.]+)/m, write: (c, v) => c.replace(/^(\s*ruby\s+)[0-9.]+/m, `$1${v}`) },
      { file: "Gemfile", re: /^\s*ruby\s+["']([0-9]+\.[0-9]+\.[0-9]+)["']/m, write: (c, v) => c.replace(/^(\s*ruby\s+["'])[0-9.]+(["'])/m, `$1${v}$2`) },
    ],
  },
  npm: {
    id: "node",
    slug: "nodejs",
    granularity: "patch",
    pins: [
      { file: ".node-version", re: /v?([0-9]+(?:\.[0-9]+){0,2})/, write: (_c, v) => v + "\n" },
      { file: ".nvmrc", re: /v?([0-9]+(?:\.[0-9]+){0,2})/, write: (_c, v) => v + "\n" },
      { file: ".tool-versions", re: /^\s*node(?:js)?\s+v?([0-9.]+)/m, write: (c, v) => c.replace(/^(\s*node(?:js)?\s+)v?[0-9.]+/m, `$1${v}`) },
    ],
  },
  go: {
    id: "go",
    slug: "go",
    granularity: "minor", // go.mod pins x.y
    pins: [
      { file: "go.mod", re: /^\s*go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/m, write: (c, v) => c.replace(/^(\s*go\s+)[0-9.]+/m, `$1${v}`) },
      { file: ".go-version", re: /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/, write: (_c, v) => v + "\n" },
    ],
  },
  composer: {
    id: "php",
    slug: "php",
    granularity: "minor",
    pins: [
      { file: ".php-version", re: /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/, write: (_c, v) => v + "\n" },
      { file: "composer.json", re: /"php"\s*:\s*"[^0-9]*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/, write: (c, v) => c.replace(/("php"\s*:\s*")[^"]*(")/, `$1${v}$2`) },
    ],
  },
};
// npm aliases (yarn/pnpm advisories also use "npm")
const ECOSYSTEM_ALIASES = { yarn: "npm", pnpm: "npm" };

// ---- endoflife.date (cached) -----------------------------------------------
const cache = new Map(); // slug -> { at, data }
const TTL = 24 * 3600 * 1000;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "dependency-dashboard" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function cycles(slug) {
  const c = cache.get(slug);
  if (c && Date.now() - c.at < TTL) return c.data;
  const data = await fetchJSON(`https://endoflife.date/api/${slug}.json`);
  cache.set(slug, { at: Date.now(), data });
  return data;
}

function eolPassed(eol) {
  if (eol === true) return true;
  if (eol === false || eol == null) return false;
  const d = Date.parse(eol);
  return Number.isFinite(d) ? d < Date.now() : false;
}

function cycleOf(version) {
  const m = String(version).match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(version).split(".")[0];
}

function cmpCycle(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// "Smallest safe jump": the OLDEST cycle still in support, preferring an LTS line
// where the product marks them (Node). Ruby/Go/PHP have no `lts` → fall through.
function recommendTarget(list, granularity) {
  const supported = list.filter((c) => !eolPassed(c.eol)); // endoflife.date is newest-first
  if (!supported.length) return null;
  const lts = supported.filter((c) => c.lts);
  const pick = (lts.length ? lts : supported).slice(-1)[0];
  const version = granularity === "minor" ? String(pick.cycle) : pick.latest || String(pick.cycle);
  return { cycle: String(pick.cycle), version, lts: !!pick.lts };
}

/** EOL status for one pinned runtime version. */
async function supportStatus(slug, version, granularity) {
  if (!version) return null;
  let list;
  try {
    list = await cycles(slug);
  } catch {
    return null; // offline / API down — fail open (don't flag)
  }
  // Match the version to its cycle by prefix — handles BOTH major-only cycles
  // (Node "18") and major.minor cycles (Ruby "3.3", Go "1.24", PHP "8.2") without
  // per-runtime granularity config.
  const row = list.find((c) => {
    const cy = String(c.cycle);
    return version === cy || String(version).startsWith(cy + ".");
  });
  let eol;
  if (row) {
    eol = eolPassed(row.eol);
  } else {
    // unknown cycle: EOL if it's older than the oldest cycle endoflife still lists
    const oldest = list.map((c) => String(c.cycle)).sort(cmpCycle)[0];
    eol = oldest ? cmpCycle(cycleOf(version), oldest) < 0 : false;
  }
  return {
    eol,
    eolDate: row && typeof row.eol === "string" ? row.eol : null,
    target: recommendTarget(list, granularity),
  };
}

// ---- per-repo detection (reads pin files via the GitHub contents API) -------
async function ghFileRaw(nwo, file) {
  const res = await run("gh", ["api", `repos/${nwo}/contents/${file}`, "-H", "Accept: application/vnd.github.raw"]);
  return res.code === 0 ? res.stdout : null;
}

function extractFromContent(rt, file, content) {
  const pin = rt.pins.find((p) => p.file === file);
  if (!pin) return null;
  const m = content.match(pin.re);
  return m ? m[1] : null;
}

/**
 * Find EOL runtimes for a repo given its ecosystems (e.g. {rubygems:5, npm:2}).
 * Returns [{ id, slug, pinned, pinFile, eolDate, target:{cycle,version,lts} }].
 */
async function checkRepoEol(nwo, ecosystems) {
  const ecos = new Set(Object.keys(ecosystems || {}).map((e) => ECOSYSTEM_ALIASES[e] || e));
  const findings = [];
  for (const eco of ecos) {
    const rt = RUNTIMES[eco];
    if (!rt) continue;
    let pinned = null;
    let pinFile = null;
    for (const pin of rt.pins) {
      const content = await ghFileRaw(nwo, pin.file);
      if (content == null) continue;
      const v = extractFromContent(rt, pin.file, content);
      if (v) {
        pinned = v;
        pinFile = pin.file;
        break;
      }
    }
    if (!pinned) continue;
    const st = await supportStatus(rt.slug, pinned, rt.granularity);
    if (st && st.eol && st.target) {
      findings.push({ id: rt.id, slug: rt.slug, pinned, pinFile, eolDate: st.eolDate, target: st.target });
    }
  }
  return findings;
}

// Rewrite every pin file that exists in `dir` for a runtime to `version`.
// Returns the list of files changed. Used by the upgrade-PR job.
function writePins(dir, ecosystemOrId, version) {
  const rt =
    RUNTIMES[ecosystemOrId] || Object.values(RUNTIMES).find((r) => r.id === ecosystemOrId);
  if (!rt) return [];
  const changed = [];
  for (const pin of rt.pins) {
    const p = path.join(dir, pin.file);
    if (!fsSync.existsSync(p)) continue;
    const before = fsSync.readFileSync(p, "utf8");
    const after = pin.write(before, version);
    if (after !== before) {
      fsSync.writeFileSync(p, after);
      changed.push(pin.file);
    }
  }
  return changed;
}

module.exports = { supportStatus, checkRepoEol, writePins, RUNTIMES };
