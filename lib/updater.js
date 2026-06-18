"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { run, runOrThrow, stream, todayStamp } = require("./exec");
const { vulnerablePackagesByEcosystem, fetchInstalledVersions } = require("./github");
const { jobContext } = require("./job");
const { writePins } = require("./eol");
const state = require("./state");

const exists = (p) => fsSync.existsSync(p);
const has = (dir, f) => exists(path.join(dir, f));
const fileMatch = (dir, name, re) => {
  const p = path.join(dir, name);
  if (!exists(p)) return null;
  const m = fsSync.readFileSync(p, "utf8").match(re);
  return m ? m[1] : null;
};
const hasGemspec = (dir) => {
  try {
    return fsSync.readdirSync(dir).some((f) => f.endsWith(".gemspec"));
  } catch {
    return false;
  }
};
// Loose version compare (numeric segments; non-numeric → 0). >0 ⇒ a newer than b.
function cmpVer(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// npm-ecosystem advisories are mostly TRANSITIVE deps a targeted `update`/`audit fix`
// can't move (a parent's range pins them below the patch). Dedupe the flagged packages
// by name, taking the highest patched floor so one override satisfies all its advisories.
function maxPatchedByPkg(pkgs) {
  const m = new Map();
  for (const p of pkgs || []) {
    // Prefer the annotated target (a same-major fix when one was chosen over a
    // cross-major floor); fall back to GitHub's raw patched floor.
    const floor = p.target || p.patched;
    if (!p.pkg || !floor) continue;
    const cur = m.get(p.pkg);
    if (!cur || cmpVer(floor, cur) > 0) m.set(p.pkg, floor);
  }
  return m;
}

// Force each given package (the transitive survivors of the post-update advisory
// verification) to ">=patched <nextMajor" via the package manager's override
// mechanism — npm `overrides`, pnpm `pnpm.overrides`, or yarn `resolutions`.
// The major cap keeps it the smallest safe jump. Returns the field name, or null.
function applyJsOverrides(dir, patchedByPkg) {
  const pkgPath = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const isPnpm = fsSync.existsSync(path.join(dir, "pnpm-lock.yaml"));
  const isYarn = !isPnpm && fsSync.existsSync(path.join(dir, "yarn.lock"));
  let target, field;
  if (isPnpm) {
    pkg.pnpm = pkg.pnpm || {};
    pkg.pnpm.overrides = pkg.pnpm.overrides || {};
    target = pkg.pnpm.overrides;
    field = "pnpm.overrides";
  } else if (isYarn) {
    pkg.resolutions = pkg.resolutions || {};
    target = pkg.resolutions;
    field = "resolutions";
  } else {
    pkg.overrides = pkg.overrides || {};
    target = pkg.overrides;
    field = "overrides";
  }
  for (const [name, patched] of patchedByPkg) {
    const major = parseInt(String(patched), 10) || 0;
    target[name] = `>=${patched} <${major + 1}`;
  }
  fsSync.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return field;
}

/** Is an executable on PATH? */
async function onPath(cmd) {
  const res = await run("sh", ["-c", `command -v ${cmd}`]);
  return res.code === 0;
}

// --- Post-update advisory verification (the "re-audit" step) -----------------
// Every resolved version of `pkg` across whichever JS lockfiles exist. A tree can
// hold several copies (nested resolution), and an advisory is only cleared when
// EVERY remaining copy is at/above the patched floor — so collect them all.
function resolvedJsVersions(dir, pkg) {
  const versions = new Set();
  const read = (f) => {
    try { return fsSync.readFileSync(path.join(dir, f), "utf8"); } catch { return null; }
  };
  const npmLock = read("package-lock.json") || read("npm-shrinkwrap.json");
  if (npmLock) {
    try {
      const json = JSON.parse(npmLock);
      // v2/v3: `packages` keyed by node_modules path (root, nested, workspaces)
      for (const [k, v] of Object.entries(json.packages || {})) {
        if (v && v.version && (k === `node_modules/${pkg}` || k.endsWith(`/node_modules/${pkg}`))) versions.add(v.version);
      }
      // v1: nested `dependencies` tree
      const walk = (deps) => {
        for (const [name, info] of Object.entries(deps || {})) {
          if (name === pkg && info && info.version) versions.add(info.version);
          if (info && info.dependencies) walk(info.dependencies);
        }
      };
      walk(json.dependencies);
    } catch { /* unparseable lockfile — fall through to other formats */ }
  }
  const yarnLock = read("yarn.lock");
  if (yarnLock) {
    // v1: `pkg@range, pkg@range2:` header + `  version "x"`; berry: `"pkg@npm:range":` + `version: x`
    for (const block of yarnLock.split(/\n\s*\n/)) {
      const head = block.split("\n").find((l) => l && !/^\s/.test(l) && !l.startsWith("#"));
      if (!head) continue;
      const specs = head.replace(/:\s*$/, "").split(",").map((s) => s.trim().replace(/^"+|"+$/g, ""));
      if (!specs.length || !specs.every((s) => s.startsWith(`${pkg}@`))) continue;
      const vm = block.match(/^\s+version:?\s+"?([^"\s]+)"?/m);
      if (vm) versions.add(vm[1]);
    }
  }
  const pnpmLock = read("pnpm-lock.yaml");
  if (pnpmLock) {
    // packages/snapshots keys across formats: v5 `/pkg/1.0.0:`, v6 `/pkg@1.0.0:`,
    // v9 `pkg@1.0.0:` — optionally quoted, with peer suffixes `(...)` after the version.
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s{2}['"]?/?${escaped}[@/]([0-9][^'":()\\s]*)`, "gm");
    let m;
    while ((m = re.exec(pnpmLock))) versions.add(m[1]);
  }
  return [...versions];
}

/** Direct dependency names declared in the ROOT package.json (all dep sections). */
function directJsDepNames(dir) {
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8"));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
  } catch {
    return new Set();
  }
}

// A flagged DIRECT dependency gets its manifest range bumped (self-documenting,
// Dependabot-friendly) — never an override. Returns ["pkg → ^x.y.z", …].
function bumpDirectJsDeps(dir, bumps) {
  const pkgPath = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const bumped = [];
  for (const [name, patched] of bumps) {
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (pkg[sec] && pkg[sec][name]) {
        pkg[sec][name] = `^${patched}`;
        bumped.push(`${name} → ^${patched}`);
        break;
      }
    }
  }
  if (bumped.length) fsSync.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return bumped;
}

// The only files a dependency-update / runtime-upgrade job is allowed to commit:
// manifests, lockfiles, and runtime pin files (basename match, so workspace-nested
// manifests count). Everything else that changed mid-job is repo tooling acting on
// its own — issue-tracker state, codegen, postinstall output — and `git add -A`
// would ship it into the PR. Worse, junk staged at the "did the gentle update
// change anything?" probe makes the updater skip the overrides fallback.
const INTENDED_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock",
  "go.mod", "go.sum",
  ".ruby-version", ".node-version", ".nvmrc", ".go-version", ".php-version", ".tool-versions", ".mise.toml",
]);

/** Stage exactly the job's intended changes; unstage (and log) anything else. */
async function stageIntendedChanges(dir, sh, log) {
  await sh("git", ["add", "-A"]);
  const out = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout;
  const unexpected = out.split("\n").filter(Boolean).filter((f) => !INTENDED_FILES.has(path.basename(f)));
  if (unexpected.length) {
    log(
      `Excluding ${unexpected.length} unrelated change(s) repo tooling made mid-job: ` +
        `${unexpected.slice(0, 8).join(", ")}${unexpected.length > 8 ? ", …" : ""}`,
      "warn"
    );
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...unexpected]);
  }
}

// --- Ruby / Bundler environment resolution ---------------------------------
// Repos commonly pin an exact Ruby (.ruby-version / .mise.toml / Gemfile
// `ruby "x.y.z"`). Bundler ENFORCES that pin, so bundler must run under a
// matching Ruby. We invoke the exact mise-installed Ruby's `bundle` binary
// directly: that skips mise's trust prompt and, crucially, never lets the
// command degrade to macOS system Ruby — whose gem path (/Library/Ruby) is
// read-only and produces a misleading "grant write permissions" error.

function readRubyVersion(dir) {
  return (
    fileMatch(dir, ".ruby-version", /([0-9]+\.[0-9]+\.[0-9]+)/) || // tolerates leading space
    fileMatch(dir, ".mise.toml", /^\s*ruby\s*=\s*["']([0-9.]+)["']/m) ||
    fileMatch(dir, ".tool-versions", /^\s*ruby\s+([0-9.]+)/m) ||
    fileMatch(dir, "Gemfile", /^\s*ruby\s+["']([0-9]+\.[0-9]+\.[0-9]+)["']/m) // exact literal pins only
  );
}

function miseRubyBundle(version) {
  if (!version) return null;
  const bin = path.join(os.homedir(), ".local/share/mise/installs/ruby", version, "bin/bundle");
  return exists(bin) ? bin : null;
}

// Node pin, mirroring readRubyVersion: .node-version / .nvmrc / mise + tool-versions
// / package.json engines. Exact x.y.z preferred; a bare major (e.g. "20") is fine —
// mise resolves it to the latest matching release.
function readNodeVersion(dir) {
  let v =
    fileMatch(dir, ".node-version", /v?([0-9]+(?:\.[0-9]+){0,2})/) ||
    fileMatch(dir, ".nvmrc", /v?([0-9]+(?:\.[0-9]+){0,2})/) ||
    fileMatch(dir, ".mise.toml", /^\s*node\s*=\s*["']?v?([0-9]+(?:\.[0-9]+){0,2})/m) ||
    fileMatch(dir, ".tool-versions", /^\s*node(?:js)?\s+v?([0-9]+(?:\.[0-9]+){0,2})/m);
  if (!v) {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8"));
      const e = pkg.engines && pkg.engines.node;
      const m = e && String(e).match(/([0-9]+(?:\.[0-9]+){1,2})/); // skip ranges like ">=18"
      if (m) v = m[1];
    } catch {
      /* no/!parseable package.json */
    }
  }
  return v;
}

// Go pin: .go-version / mise + tool-versions / the `go 1.x` directive in go.mod
// (a minimum, which mise resolves to the latest matching release).
function readGoVersion(dir) {
  return (
    fileMatch(dir, ".go-version", /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/) ||
    fileMatch(dir, ".mise.toml", /^\s*go\s*=\s*["']?v?([0-9.]+)/m) ||
    fileMatch(dir, ".tool-versions", /^\s*go(?:lang)?\s+v?([0-9.]+)/m) ||
    fileMatch(dir, "go.mod", /^\s*go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/m)
  );
}

// PHP pin: .php-version / mise + tool-versions / composer.json platform.php or
// require.php (the latter is often a range like "^8.1" — take its base version).
function readPhpVersion(dir) {
  let v =
    fileMatch(dir, ".php-version", /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/) ||
    fileMatch(dir, ".mise.toml", /^\s*php\s*=\s*["']?v?([0-9.]+)/m) ||
    fileMatch(dir, ".tool-versions", /^\s*php\s+v?([0-9.]+)/m);
  if (!v) {
    try {
      const c = JSON.parse(fsSync.readFileSync(path.join(dir, "composer.json"), "utf8"));
      const e = (c.config && c.config.platform && c.config.platform.php) || (c.require && c.require.php);
      const m = e && String(e).match(/([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
      if (m) v = m[1];
    } catch {
      /* no/!parseable composer.json */
    }
  }
  return v;
}

// Concurrent jobs must never run the SAME `mise install` at once — two repos
// pinning the same version would compile/write into one prefix dir and can
// corrupt each other (a real risk: a `make install` race). This gate (a) JOINS
// callers requesting an identical tool@version to one in-flight install, and
// (b) SERIALIZES all installs so at most one runs at a time (no 3 concurrent
// Ruby compiles thrashing the CPU, and no shared-tool races between repos).
const installInflight = new Map(); // key -> Promise
let installChain = Promise.resolve();

function gateInstall(key, runFn, onWait) {
  if (installInflight.has(key)) {
    if (onWait) onWait();
    return installInflight.get(key); // identical install already in progress → join it
  }
  const started = installChain.then(runFn, runFn); // else queue after the current install
  installChain = started.catch(() => {});
  const tracked = started.finally(() => installInflight.delete(key));
  installInflight.set(key, tracked);
  return tracked;
}

/**
 * Close this repo's OPEN, tool-opened dependency-update PRs as obsolete, leaving an
 * explanatory comment and deleting the branch. Returns the closed PR URLs.
 *
 * Only branches under config.branchPrefix qualify, so human PRs and runtime-upgrade /
 * constraint-bump PRs are never touched. Best-effort: a failed list/close is logged
 * and skipped, never thrown — closing stale PRs must not fail an otherwise-clean run.
 */
async function closeObsoleteUpdatePRs({ nwo, config, log }) {
  const prefix = config.branchPrefix || "dependency-updates/soc2";
  const listed = await run("gh", [
    "pr", "list", "--repo", nwo, "--state", "open",
    "--json", "number,headRefName,url", "--limit", "100",
  ]);
  if (listed.code !== 0) {
    log("Could not list PRs to check for obsolete update PRs — skipping.", "warn");
    return [];
  }
  let prs = [];
  try {
    prs = JSON.parse(listed.stdout || "[]");
  } catch {
    return [];
  }
  const obsolete = prs.filter((p) => p.headRefName && p.headRefName.startsWith(prefix));
  if (!obsolete.length) {
    log("No obsolete update PRs to close.");
    return [];
  }
  const comment =
    "Closed automatically by the Dependency Dashboard: a re-check produced no " +
    "dependency changes, so the flagged advisories are already resolved in the " +
    "current tree (e.g. patched by another merged PR). This update PR is no longer needed.";
  const closed = [];
  for (const pr of obsolete) {
    const res = await run("gh", [
      "pr", "close", String(pr.number), "--repo", nwo, "--comment", comment, "--delete-branch",
    ]);
    if (res.code === 0) {
      log(`Closed obsolete update PR #${pr.number} (${pr.headRefName}) — ${pr.url}`, "warn");
      closed.push(pr.url);
    } else {
      log(`Could not close PR #${pr.number}: ${(res.stderr || res.stdout || "").trim()}`, "warn");
    }
  }
  return closed;
}

/**
 * Comment `@dependabot recreate` on every OPEN `dependabot/*` PR for the repo, so
 * Dependabot re-evaluates each against the freshly-updated default branch and closes
 * the ones now superseded — while keeping (and rebasing) any still-needed bump.
 * Delegating the redundancy decision to Dependabot keeps non-security bumps (pagy,
 * aws-sdk, …) safe. Deduped to once per PR per day. Best-effort: never throws.
 */
// Compare dotted numeric versions. Returns <0 / 0 / >0, or null if either side has
// a non-numeric segment (git-sha "version", prerelease tag) — i.e. "can't tell".
function cmpVersions(a, b) {
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

async function nudgeDependabotPRs({ nwo, repo, config, log }) {
  const org = (config && config.org) || String(nwo).split("/")[0];
  const listed = await run("gh", [
    "pr", "list", "--repo", nwo, "--state", "open",
    "--json", "number,headRefName,url,title", "--limit", "100",
  ]);
  if (listed.code !== 0) {
    log("Could not list PRs to nudge Dependabot — skipping.", "warn");
    return [];
  }
  let prs = [];
  try {
    prs = JSON.parse(listed.stdout || "[]");
  } catch {
    return [];
  }
  const dependabot = prs.filter((p) => p.headRefName && p.headRefName.startsWith("dependabot/"));
  if (!dependabot.length) {
    log("No open Dependabot PRs to nudge.");
    return [];
  }

  // Only nudge PRs whose target version is already satisfied on the default branch,
  // so still-needed bumps (aws-sdk, pagy, …) are left alone. Target is parsed from
  // the standard "Bump <pkg> from <a> to <b>" title; installed versions come from the
  // default-branch lockfiles. Anything we can't verify is skipped, not nudged.
  let installed = {};
  try {
    installed = await fetchInstalledVersions(org, repo.name);
  } catch {
    installed = {};
  }

  const nudged = [];
  let skipped = 0;
  for (const pr of dependabot) {
    const m = /bump\s+(\S+)\s+from\s+\S+\s+to\s+(\S+)/i.exec(pr.title || "");
    const pkg = m && m[1];
    const target = m && m[2];
    const cur = pkg ? installed[pkg] : null;
    const cmp = cur != null && target ? cmpVersions(cur, target) : null;
    if (cmp == null || cmp < 0) { // unverifiable, or default branch not yet at the target
      skipped++;
      continue;
    }
    if (state.dependabotNudgedToday(repo.name, pr.number)) continue; // dedupe
    const res = await run("gh", [
      "pr", "comment", String(pr.number), "--repo", nwo, "--body", "@dependabot recreate",
    ]);
    if (res.code === 0) {
      state.recordDependabotNudge(repo.name, pr.number);
      log(`Nudged Dependabot PR #${pr.number} (${pr.headRefName}) — ${pkg} already ≥ ${target} on the default branch; it self-closes.`, "warn");
      nudged.push(pr.url);
    } else {
      log(`Could not comment on Dependabot PR #${pr.number}: ${(res.stderr || res.stdout || "").trim()}`, "warn");
    }
  }
  if (skipped) log(`Left ${skipped} Dependabot PR(s) alone — not yet satisfied on the default branch, or unverifiable.`);
  return nudged;
}

/**
 * Drive a full update-PR for one repo, emitting progress via emit(type, data).
 * emit types: 'log' (line, level), 'step' (name), 'done' (prUrl|null, changed), 'error' (message).
 *
 * Strategy: lockfile-only, targeted at the packages GitHub actually flagged.
 * That keeps diffs small and reviewable and avoids native builds / registry
 * auth failures. CI on the resulting PR is the real validation gate.
 */
// `upgrade` (optional): { id, ecosystem, from, to } — when set, this PR also bumps
// the repo's pinned runtime off an end-of-life version. writePins rewrites the pin
// files; the bootstrap below then provisions the new runtime automatically.
async function createUpdatePR({ config, repo, emit, upgrade }) {
  const { nwo, dir, workRoot, log, step, onLn, sh } = await jobContext({ config, repo, emit });
  const branch = upgrade
    ? `runtime-upgrade/${upgrade.id}-${upgrade.to}-${todayStamp()}`
    : `${config.branchPrefix || "dependency-updates/soc2"}-${todayStamp()}`;
  const base = repo.defaultBranch || "main";

  // ---- 1. Fresh clone (shallow) ------------------------------------------
  step("Cloning");
  if (exists(dir)) {
    log(`Removing previous working copy at ${dir}`);
    await fs.rm(dir, { recursive: true, force: true });
  }
  log(`$ gh repo clone ${nwo} ${dir} -- --depth=1`);
  await stream("gh", ["repo", "clone", nwo, dir, "--", "--depth=1"], { cwd: workRoot }, onLn);
  if (!exists(path.join(dir, ".git"))) {
    throw new Error("Clone failed — no .git directory produced.");
  }

  // ---- 2. Branch ----------------------------------------------------------
  step("Branching");
  log(`$ git switch -c ${branch}`);
  // -C lets us re-create the branch if a same-day run already made it.
  await sh("git", ["switch", "-C", branch]);

  // ---- 2.1 Runtime upgrade: rewrite the pin off its EOL version -----------
  if (upgrade) {
    step("Upgrading runtime pin");
    const changed = writePins(dir, upgrade.ecosystem, upgrade.to);
    if (!changed.length) {
      emit("error", { message: `No ${upgrade.id} pin file found to rewrite — aborting upgrade.` });
      return { prUrl: null, changed: false };
    }
    log(`Rewrote ${upgrade.id} ${upgrade.from} → ${upgrade.to} in: ${changed.join(", ")}`, "warn");
  }

  // ---- 2.5 Bootstrap the repo's pinned toolchain via mise ----------------
  // Repos pin exact Ruby/Node versions that Bundler/npm assume or enforce.
  // Provision whatever's pinned so the commands below run under the right runtime
  // instead of failing or degrading to system Ruby. `mise install` is idempotent
  // (fast no-op when already present); a brand-new version compiles once.
  step("Bootstrapping toolchain");
  const haveMise = await onPath("mise");
  const miseEnv = { ...process.env, MISE_YES: "1" };
  const reqNode = readNodeVersion(dir);
  const reqGo = readGoVersion(dir);
  const reqPhp = readPhpVersion(dir);

  // Install a pinned tool version through the gate (dedup identical + serialize),
  // so two concurrent jobs never compile the same version into the same dir.
  const provision = (tool, ver) =>
    gateInstall(
      `${tool}@${ver}`,
      async () => {
        log(`$ mise install ${tool}@${ver}`, "warn");
        return stream("mise", ["install", `${tool}@${ver}`], { cwd: dir, env: miseEnv }, onLn);
      },
      () => log(`Waiting — ${tool}@${ver} is being installed for another repo…`, "warn")
    );

  if (haveMise) {
    if (has(dir, ".mise.toml")) await run("mise", ["trust", path.join(dir, ".mise.toml")], { cwd: dir }).catch(() => {});
    // Tools declared in mise/.tool-versions config (unique key → not deduped — each
    // repo installs its own declared tools — but still serialized with every install).
    if (has(dir, ".mise.toml") || has(dir, ".tool-versions")) {
      await gateInstall(`config:${repo.name}`, async () => {
        log("$ mise install   (tools declared by the repo)");
        return stream("mise", ["install"], { cwd: dir, env: miseEnv }, onLn);
      });
    }
    // Idiomatic single-tool pins (.ruby-version, .node-version, .go-version, …).
    const reqRubyBoot = readRubyVersion(dir);
    if (reqRubyBoot && config.autoInstallRuby !== false && !miseRubyBundle(reqRubyBoot)) await provision("ruby", reqRubyBoot);
    if (reqNode && config.autoInstallNode !== false) await provision("node", reqNode);
    if (reqGo && config.autoInstallGo !== false) await provision("go", reqGo);
    if (reqPhp && config.autoInstallPhp !== false) await provision("php", reqPhp);
  } else {
    log("mise not on PATH — using system runtimes; pinned versions can't be auto-provisioned.", "warn");
  }

  // Run an ecosystem command under mise (so the repo's pinned runtime is used),
  // falling back to a system binary. Probes `<cmd> --version` first so we never
  // silently no-op. Returns the exit code, or null if the tool can't be found.
  const miseExec = (tool, ver) => (ver ? ["exec", `${tool}@${ver}`, "--"] : ["exec", "--"]);
  const toolCmd = async (execArgs, cmd, args) => {
    if (haveMise && (await run("mise", [...execArgs, cmd, "--version"], { cwd: dir, env: miseEnv })).code === 0) {
      log(`$ mise exec -- ${cmd} ${args.join(" ")}`);
      return sh("mise", [...execArgs, cmd, ...args]);
    }
    if (await onPath(cmd)) {
      log(`$ ${cmd} ${args.join(" ")}`);
      return sh(cmd, args);
    }
    return null;
  };
  const miseNodeArgs = miseExec("node", reqNode);
  const nodeCmd = (cmd, args) => toolCmd(miseNodeArgs, cmd, args);
  const goCmd = (cmd, args) => toolCmd(miseExec("go", reqGo), cmd, args);
  const composerCmd = (cmd, args) => toolCmd(miseExec("php", reqPhp), cmd, args);

  // ---- 3. Targeted lockfile updates per ecosystem -------------------------
  step("Updating dependencies");
  const byEco = vulnerablePackagesByEcosystem(repo);
  const notes = [];
  // Flagged packages whose security fix is SAME-major but the lockfile-only update
  // still can't reach it — a Gemfile/package.json or parent-dependency constraint
  // caps them below their patched floor. Discovered post-update (npm + Ruby app
  // re-audits) and rendered as a dedicated "Blocked — needs a manifest change"
  // table. Major-only advisories are NOT here; they get the forcedMajors holdback.
  const blockedPkgs = [];

  // Minimize-major-bumps policy: a flagged package whose ONLY security fix is in a
  // higher major (no same-major patch — e.g. devise 4.x → 5.x) is excluded from this
  // automated, lockfile-only update, so we never silently apply a likely-breaking major.
  // It stays flagged and is listed in the PR body for a deliberate, manual opt-in.
  // (npm `audit fix` without --force already stays in-range; this also keeps the
  // overrides fallback from forcing a major.) Toggle with minimizeMajorBumps.
  const forcedMajors = (config.minimizeMajorBumps === false ? [] : (repo.packages || []).filter((p) => p.majorRequired));
  if (forcedMajors.length) {
    const skip = new Set(forcedMajors.map((p) => p.pkg));
    for (const eco of Object.keys(byEco)) byEco[eco] = (byEco[eco] || []).filter((name) => !skip.has(name));
    const list = forcedMajors.map((p) => `${p.pkg} ${p.installed || "?"}→${p.target || p.patched || "?"}`).join(", ");
    notes.push(
      `Held back ${forcedMajors.length} advisor${forcedMajors.length === 1 ? "y" : "ies"} that need a **major** upgrade ` +
        `(no same-major security fix): ${list}. Excluded from this lockfile-only PR — opt in manually since a major bump is likely breaking.`
    );
    log(`Holding back ${forcedMajors.length} major-only fix(es): ${list}`, "warn");
  }
  // For a gem: the verdict on whether its constraints already permit the patches
  // (covered) or block one (blocked). Surfaced to the server so the card can route
  // to the Covered tab / the constraint-bump flow without re-running.
  let gemDisposition = null;
  // "puma→8.0.2, nokogiri→1.19.3, …" for an ecosystem — so every note carries the
  // exact packages + patched targets the AI/human needs, never just "see the log".
  const flaggedList = (eco) =>
    (repo.packages || [])
      .filter((p) => p.ecosystem === eco)
      .map((p) => `${p.pkg}→${p.patched || "?"}`)
      .join(", ") || "(none mapped)";

  // npm (package-lock.json)
  if (has(dir, "package-lock.json") || has(dir, "npm-shrinkwrap.json")) {
    const args = ["audit", "fix", "--package-lock-only", "--no-fund", "--no-audit"];
    if (config.npm?.force) args.push("--force");
    const code = await nodeCmd("npm", args);
    if (code === null) notes.push("npm unavailable (no mise Node and not on PATH) — skipped npm lockfile update.");
    else if (code !== 0) notes.push("`npm audit fix` exited non-zero — review the log; some advisories may need a manual/major bump.");
  } else if (has(dir, "pnpm-lock.yaml")) {
    const pkgs = byEco["npm"] || byEco["pnpm"] || [];
    if (!pkgs.length) {
      notes.push("pnpm-lock.yaml present but no targeted packages mapped — skipped.");
    } else {
      const code = await nodeCmd("pnpm", ["update", ...pkgs, "--lockfile-only"]);
      if (code === null) notes.push("pnpm unavailable (no mise Node/pnpm and not on PATH) — skipped.");
      else if (code !== 0) notes.push("`pnpm update --lockfile-only` exited non-zero — review the log.");
    }
  } else if (has(dir, "yarn.lock")) {
    const pkgs = byEco["npm"] || [];
    let yarnMajor = 0;
    try {
      const r = haveMise
        ? await run("mise", [...miseNodeArgs, "yarn", "--version"], { cwd: dir, env: miseEnv })
        : await run("yarn", ["--version"], { cwd: dir });
      yarnMajor = parseInt(String(r.stdout).trim(), 10) || 0;
    } catch {
      /* yarn not available */
    }
    if (pkgs.length && yarnMajor >= 2) {
      const code = await nodeCmd("yarn", ["up", ...pkgs, "--mode=update-lockfile"]);
      if (code !== null && code !== 0) notes.push("`yarn up --mode=update-lockfile` exited non-zero — review the log.");
    } else {
      notes.push(
        `yarn.lock detected (Yarn ${yarnMajor || "classic/1.x"}). These advisories are often transitive dev deps ` +
          `(e.g. pulled in via test tooling); Yarn 1.x has no safe lockfile-only bump. Add a \`resolutions\` entry in ` +
          `package.json or upgrade the parent dependency. Flagged: ${pkgs.join(", ")}`
      );
    }
  } else if (has(dir, "package.json")) {
    notes.push(
      `package.json present without a lockfile — nothing for a lockfile-only update to change. ` +
        `Flagged npm advisories: ${flaggedList("npm")}. Commit a package-lock.json, or for a transitive dep add an ` +
        `"overrides" entry pinning the patched version.`
    );
  }

  // ---- 3.1 npm: verify what the in-range update actually fixed, then escalate
  // only the true survivors. The lockfile is re-checked against each advisory's
  // patched floor (a real re-audit, not a "did git see a diff?" probe — that probe
  // both skipped overrides when a partial fix changed the lockfile AND forced
  // overrides onto packages the in-range update could have fixed). Escalation
  // follows the manual playbook: a flagged DIRECT dependency gets a manifest range
  // bump (self-documenting, Dependabot-friendly); only transitive survivors get
  // overrides/resolutions. CI is still the gate — forced bumps can break a dependent.
  const jsLock =
    has(dir, "pnpm-lock.yaml") || has(dir, "yarn.lock") || has(dir, "package-lock.json") || has(dir, "npm-shrinkwrap.json");
  if (jsLock && has(dir, "package.json") && (byEco["npm"] || []).length) {
    step("Verifying advisories against the updated lockfile");
    // NOTE: byEco["npm"] is an array of package-name STRINGS; maxPatchedByPkg needs
    // the advisory OBJECTS ({pkg, patched}). Pass the filtered packages, not byEco.
    const patchedByPkg = maxPatchedByPkg((repo.packages || []).filter((p) => p.ecosystem === "npm"));
    // A survivor still resolves below its patched floor. A package we can't find in
    // the root lockfile stays a survivor too (nested-workspace lockfiles are opaque
    // here) — the override is the conservative choice, matching the old behavior.
    const survivors = new Map();
    const fixedInRange = [];
    for (const [name, floor] of patchedByPkg) {
      const vers = resolvedJsVersions(dir, name);
      if (vers.length && !vers.some((v) => cmpVer(v, floor) < 0)) fixedInRange.push(name);
      else survivors.set(name, floor);
    }
    if (fixedInRange.length) {
      log(`✓ In-range update covers ${fixedInRange.length} of ${patchedByPkg.size} flagged package(s): ${fixedInRange.join(", ")} — no overrides needed for these.`);
    }
    if (!survivors.size) {
      log("Every flagged package now resolves at/above its patched floor — no overrides needed.");
    } else {
      const direct = directJsDepNames(dir);
      const directBumps = new Map([...survivors].filter(([n]) => direct.has(n)));
      const transitive = new Map([...survivors].filter(([n]) => !direct.has(n)));

      if (directBumps.size) {
        step("Bumping direct dependencies");
        const bumped = bumpDirectJsDeps(dir, directBumps);
        if (bumped.length) {
          log(`Raising ${bumped.length} direct dependency range(s) in package.json: ${bumped.join(", ")} (a manifest bump, not an override).`, "warn");
          notes.push(`Bumped ${bumped.length} direct dependency range(s) whose patched version was out of reach: ${bumped.join(", ")}.`);
        }
      }
      if (transitive.size) {
        step("Adding transitive overrides");
        const field = applyJsOverrides(dir, transitive);
        if (!field) {
          notes.push(`Couldn't read package.json to add overrides for ${transitive.size} flagged package(s).`);
        } else {
          const list = [...transitive].map(([n, v]) => `${n}→${v}`).join(", ");
          log(`Forcing ${transitive.size} transitive survivor(s) to patched via ${field}: ${list}.`, "warn");
          notes.push(
            `Added \`${field}\` for ${transitive.size} transitive package(s) still below their patched floor after the in-range ` +
              `update (${list}) — the patched versions are outside what the dependency tree reaches on its own.`
          );
        }
      }

      // Regenerate the lockfile so the bumps/overrides take effect.
      let rc;
      if (has(dir, "pnpm-lock.yaml")) rc = await nodeCmd("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"]);
      else if (has(dir, "yarn.lock")) rc = await nodeCmd("yarn", ["install", "--mode=update-lockfile"]);
      else rc = await nodeCmd("npm", ["install", "--package-lock-only"]);
      if (rc === null) {
        notes.push(`Wrote the dependency bumps/overrides, but no Node toolchain was available to regenerate the lockfile.`);
      } else if (rc !== 0) {
        notes.push(
          `Lockfile regen exited ${rc} after the bumps/overrides — a forced version likely conflicts with a peer/parent. ` +
            `The conflict is in the log above; the changes are staged in package.json.`
        );
      } else {
        // Re-verify so the PR never silently claims more than it delivered.
        const still = [...survivors].filter(([n, floor]) => {
          const vers = resolvedJsVersions(dir, n);
          return !vers.length || vers.some((v) => cmpVer(v, floor) < 0);
        });
        if (still.length) {
          notes.push(
            `After the bumps/overrides, ${still.length} package(s) still resolve below their patched floor: ` +
              `${still.map(([n, v]) => `${n} (needs ≥${v})`).join(", ")} — likely held back by a parent's range; ` +
              `bump the parent dependency or handle manually.`
          );
          for (const [n, floor] of still) {
            const vers = resolvedJsVersions(dir, n).sort(cmpVer);
            blockedPkgs.push({
              ecosystem: "npm",
              pkg: n,
              resolved: vers[0] || null,
              floor,
              reason: "Still below the patched floor after a manifest override — a parent dependency's range pins it; bump the parent.",
            });
          }
        }
      }
    }
  }

  // Bundler — runs for a Gemfile even WITHOUT a committed Gemfile.lock (gems): we
  // resolve + lock the dependency tree and force-add the lockfile, so a gem's
  // dependencies get patched too, not just application lockfiles. Pinned Ruby.
  if (has(dir, "Gemfile.lock") || has(dir, "Gemfile")) {
    const gems = byEco["rubygems"] || [];
    const isGem = !has(dir, "Gemfile.lock") && hasGemspec(dir);
    if (!gems.length) {
      notes.push(
        `Ruby project detected but none of the flagged advisories mapped to Bundler gems ` +
          `(ecosystems seen: ${Object.keys(repo.ecosystems || {}).join(", ") || "none"}).`
      );
    } else {
      const reqRuby = readRubyVersion(dir);
      const bundleBin = miseRubyBundle(reqRuby);
      if (reqRuby) log(`Repo pins Ruby ${reqRuby} ${bundleBin ? "(installed ✓)" : "(NOT installed)"}.`);

      if (reqRuby && !bundleBin) {
        notes.push(
          `Skipped Ruby update for ${gems.length} flagged gem(s) [${flaggedList("rubygems")}]: the repo pins Ruby ` +
            `${reqRuby} but it isn't installed and Bundler enforces the exact pin. Run \`mise install ruby@${reqRuby}\` and re-run.`
        );
      } else {
        let cmd, args;
        if (bundleBin) {
          cmd = bundleBin;
          args = ["lock", "--update", ...gems];
        } else {
          await run("mise", ["trust", path.join(dir, ".mise.toml")]).catch(() => {});
          cmd = "mise";
          args = ["exec", "--", "bundle", "lock", "--update", ...gems];
          log("No Ruby pin detected — using mise default Ruby.", "warn");
        }
        log(`$ bundle lock --update ${gems.join(" ")}${isGem ? "   (gem — generating a Gemfile.lock)" : ""}`);
        let sysRuby = false;
        const code = await stream(cmd, args, { cwd: dir, env: { ...process.env, MISE_YES: "1" } }, (line, which) => {
          if (/\/Library\/Ruby\/|grant write permissions/.test(line)) sysRuby = true;
          log(line, which === "stderr" ? "warn" : "info");
        });
        if (sysRuby) {
          notes.push(`Bundler degraded to macOS system Ruby (read-only gem path) — the pinned Ruby isn't active. Unresolved flagged gems: ${flaggedList("rubygems")}.`);
        } else if (code !== 0) {
          notes.push(
            `\`bundle lock --update ${gems.join(" ")}\` exited ${code}. Most likely a patched gem is outside a ` +
              `Gemfile/gemspec version constraint (needs a constraint bump), or a private git gem couldn't be fetched. ` +
              `Flagged: ${flaggedList("rubygems")}. The exact conflict is in the bundle output above.`
          );
        } else if (isGem) {
          // A library does NOT commit a Gemfile.lock (consuming apps resolve their own
          // versions from the gemspec constraints). So we use this resolution only to
          // CHECK whether the constraints already permit the patched versions — and
          // flag any that a constraint BLOCKS (the real, gemspec-bump fix) — then
          // discard the throwaway lockfile.
          let lockTxt = "";
          try {
            lockTxt = fsSync.readFileSync(path.join(dir, "Gemfile.lock"), "utf8");
          } catch {
            /* none generated */
          }
          const blocked = [];
          const okPins = [];
          for (const p of (repo.packages || []).filter((x) => x.ecosystem === "rubygems")) {
            const esc = p.pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const m = lockTxt.match(new RegExp(`^    ${esc} \\(([0-9][0-9.]*)`, "m"));
            const resolved = m ? m[1] : null;
            if (resolved && p.patched && cmpVer(resolved, p.patched) >= 0) okPins.push(`${p.pkg} ${resolved}`);
            else blocked.push(`${p.pkg} resolves to ${resolved || "unknown"} but the advisory needs ≥ ${p.patched || "?"}`);
          }
          gemDisposition = { state: blocked.length ? "blocked" : "covered", ok: okPins, blocked, ecosystem: "rubygems" };
          if (blocked.length) {
            notes.push(
              `This gem's constraints BLOCK ${blocked.length} patch(es): ${blocked.join("; ")}. ` +
                `Bump the version constraint in the gemspec/Gemfile and cut a release — that's the real fix ` +
                `(a gem doesn't pin a lockfile; consuming apps resolve from these constraints).`
            );
          } else {
            notes.push(
              `✓ This gem's constraints already permit the patched versions (${okPins.join(", ") || "all flagged gems"}). ` +
                `These advisories resolve to patched in any app that depends on this gem — nothing to change in the gem itself ` +
                `(libraries don't commit a Gemfile.lock).`
            );
          }
          try {
            fsSync.unlinkSync(path.join(dir, "Gemfile.lock"));
          } catch {
            /* nothing to clean */
          }
        } else {
          // App with a committed Gemfile.lock: `bundle lock --update` exiting 0 only
          // means a VALID resolution was found — a gem that a parent/Gemfile constraint
          // caps below its patched floor is left untouched, not failed. Re-read the
          // lockfile and flag any flagged gem still below its floor as blocked, so the
          // PR never silently under-delivers (mirrors the npm survivor re-audit).
          // Major-only advisories were already held back (forcedMajors) and excluded
          // from `gems` above — they get the major-upgrade table, not this one.
          let lockTxt = "";
          try {
            lockTxt = fsSync.readFileSync(path.join(dir, "Gemfile.lock"), "utf8");
          } catch {
            /* unreadable — leave blockedPkgs unchanged */
          }
          const attempted = new Set(gems);
          const floors = maxPatchedByPkg((repo.packages || []).filter((p) => p.ecosystem === "rubygems"));
          for (const [name, floor] of floors) {
            if (!attempted.has(name)) continue; // held-back majors aren't "blocked" here
            const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const m = lockTxt.match(new RegExp(`^    ${esc} \\(([0-9][0-9.]*)`, "m"));
            const resolved = m ? m[1] : null;
            if (resolved && cmpVer(resolved, floor) >= 0) continue; // reached the floor — fixed
            blockedPkgs.push({
              ecosystem: "rubygems",
              pkg: name,
              resolved,
              floor,
              reason: resolved
                ? "Capped below the patched floor by a Gemfile or parent-gem constraint — bump the blocking constraint (or parent gem) to admit the patch."
                : "Not present in the resolved lockfile after the update — likely capped or removed by a parent constraint; resolve manually.",
            });
          }
          const rb = blockedPkgs.filter((b) => b.ecosystem === "rubygems");
          if (rb.length) {
            log(
              `⚠ ${rb.length} flagged gem(s) still below their patched floor after the conservative update ` +
                `(a constraint caps them): ${rb.map((b) => `${b.pkg} ${b.resolved || "?"}<${b.floor}`).join(", ")}.`,
              "warn"
            );
            notes.push(
              `${rb.length} flagged gem(s) couldn't reach their patched floor via a lockfile-only update ` +
                `(${rb.map((b) => `${b.pkg} needs ≥${b.floor}`).join(", ")}) — a Gemfile/parent constraint caps them. See the Blocked table below.`
            );
          }
        }
      }
    }
  }

  // Composer (composer.lock) — runs under the repo's pinned PHP when mise has it.
  if (has(dir, "composer.lock")) {
    const pkgs = byEco["composer"] || [];
    if (!pkgs.length) {
      notes.push("composer.lock present but no targeted packages mapped — skipped.");
    } else {
      const code = await composerCmd("composer", ["update", ...pkgs, "--no-install", "--no-interaction", "--no-scripts"]);
      if (code === null) notes.push(`composer.lock present but composer/PHP is unavailable (no mise PHP, not on PATH). Flagged: ${flaggedList("composer")}.`);
      else if (code !== 0) notes.push(`\`composer update ${pkgs.join(" ")}\` exited ${code} — a patched package is likely outside a composer.json constraint. Flagged: ${flaggedList("composer")}. The conflict is in the output above.`);
    }
  }

  // Go modules — run under the repo's pinned Go (go.mod `go x.y` / .go-version) when present.
  if (has(dir, "go.mod")) {
    const mods = byEco["go"] || [];
    if (mods.length) {
      const first = await goCmd("go", ["get", `${mods[0]}@latest`]);
      if (first === null) {
        notes.push(`go.mod present but the Go toolchain is unavailable (no mise Go, not on PATH). Flagged modules: ${flaggedList("go")}.`);
      } else {
        for (const m of mods.slice(1)) await goCmd("go", ["get", `${m}@latest`]);
        await goCmd("go", ["mod", "tidy"]);
      }
    }
  }

  // ---- 4. Did anything actually change? -----------------------------------
  step("Checking for changes");
  await stageIntendedChanges(dir, sh, log);
  const diff = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  // exit 0 = no changes, exit 1 = changes staged.
  if (diff.code === 0) {
    // Never leave a generic dead-end: if nothing earlier explained it, list the
    // exact advisories so the AI auto-fixer (or a human) has something to act on.
    if (!notes.length && (repo.packages || []).length) {
      const list = (repo.packages || []).map((p) => `${p.pkg}→${p.patched || "?"}`).slice(0, 15).join(", ");
      notes.push(
        `The targeted updater produced no manifest/lockfile change for ${(repo.packages || []).length} flagged ` +
          `advisor${(repo.packages || []).length === 1 ? "y" : "ies"} [${list}]. They're likely already at the patched ` +
          `version in the resolved tree, or need a manifest constraint bump / a transitive parent to be updated.`
      );
    }
    log("No automatic lockfile changes were produced.", "warn");
    if (notes.length) notes.forEach((n) => log("• " + n, "warn"));

    // A re-check that produces no change means the flagged advisories are already
    // satisfied in the resolved tree (e.g. another PR merged the bump). If a prior
    // tool-opened update PR is still open for this repo, it's now obsolete — close
    // it, mirroring how `@dependabot rebase` auto-closes a no-longer-needed PR.
    // Scoped to our own dependency-update branches, so human PRs and runtime-upgrade
    // / constraint-bump PRs are never touched. Opt out with closeObsoletePRs: false.
    let closedPRs = [];
    if (!upgrade && config.closeObsoletePRs !== false) {
      step("Closing obsolete PR(s)");
      closedPRs = await closeObsoleteUpdatePRs({ nwo, config, log });
    }
    // Deps are satisfied on the default branch, so any open Dependabot PR for this
    // repo is likely superseded — ask Dependabot to re-evaluate and self-close them.
    let nudgedDependabot = [];
    if (!upgrade && config.nudgeDependabotOnClear !== false) {
      step("Nudging Dependabot PR(s)");
      nudgedDependabot = await nudgeDependabotPRs({ nwo, repo, config, log });
    }
    emit("done", { prUrl: null, changed: false, branch, notes, disposition: gemDisposition, closedPRs, nudgedDependabot });
    return { prUrl: null, changed: false, notes, disposition: gemDisposition, closedPRs, nudgedDependabot };
  }

  // ---- 5. Commit ----------------------------------------------------------
  step("Committing");
  const pkgCount = (repo.packages || []).length;
  const commitMsg = upgrade
    ? `chore(runtime): upgrade ${upgrade.id} ${upgrade.from} → ${upgrade.to} (end-of-life)\n\n` +
      `Automated runtime upgrade off an end-of-life ${upgrade.id} version, generated by the ` +
      `Dependency Dashboard on ${todayStamp()}. A major runtime bump likely needs code/dependency fixes — review carefully.\n`
    : `chore(deps): SOC 2 dependency remediation (lockfile updates)\n\n` +
      `Automated, lockfile-only updates targeting ${pkgCount} open Dependabot ` +
      `advisory package(s). Generated by the Dependency Dashboard on ${todayStamp()}.\n`;
  await sh("git", ["commit", "-m", commitMsg]);
  // Surface exactly what the PR will contain — stray files are easiest to catch here.
  const committedFiles = (await run("git", ["-C", dir, "show", "--name-only", "--format="])).stdout.split("\n").filter(Boolean);
  log(`Committed ${committedFiles.length} file(s): ${committedFiles.slice(0, 10).join(", ")}${committedFiles.length > 10 ? ", …" : ""}`);

  // ---- 6. Push ------------------------------------------------------------
  step("Pushing branch");
  log(`$ git push --force-with-lease -u origin ${branch}`);
  // force-with-lease so a same-day re-run can refresh the branch safely.
  const pushCode = await sh("git", ["push", "--force-with-lease", "-u", "origin", branch]);
  if (pushCode !== 0) {
    // first push of a brand-new branch has no lease ref; fall back to plain push.
    log("Retrying push without lease (new branch)…", "warn");
    await sh("git", ["push", "-u", "origin", branch]);
  }

  // ---- 7. Open (or find) the PR ------------------------------------------
  step("Opening pull request");
  // repo.packages is annotated (installed/target/bump/major-required) by the model
  // refresh that runs before the job, so the body can show from→to and flag majors.
  const body = upgrade ? upgradeBody(repo, upgrade, notes) : prBody(repo, notes, blockedPkgs);
  const bodyFile = path.join(os.tmpdir(), `hw-pr-${repo.name}-${todayStamp()}.md`);
  await fs.writeFile(bodyFile, body, "utf8");

  const title = upgrade
    ? `⚠ chore(runtime): upgrade ${upgrade.id} ${upgrade.from} → ${upgrade.to} (end-of-life)`
    : `chore(deps): SOC 2 dependency remediation — ${todayStamp()}`;
  const prArgs = [
    "pr", "create",
    "--repo", nwo,
    "--base", base,
    "--head", branch,
    "--title", title,
    "--body-file", bodyFile,
  ];
  if (config.draftPRs) prArgs.push("--draft");

  const create = await run("gh", prArgs);
  let prUrl = null;
  if (create.code === 0) {
    prUrl = (create.stdout.trim().match(/https?:\/\/\S+/) || [])[0] || create.stdout.trim();
    log(create.stdout.trim());
  } else if (/already exists/i.test(create.stderr)) {
    log("A PR already exists for this branch — refreshing its title & body.", "warn");
    const found = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--json", "url", "--jq", ".[0].url"]);
    prUrl = found.stdout.trim() || null;
    // `gh pr create` only sets the body at creation — a re-run force-pushes the branch
    // but the description would otherwise stay frozen at the original run, hiding the
    // current Blocked/major tables & notes. Sync it so the PR always matches this run.
    if (prUrl) {
      const edit = await run("gh", ["pr", "edit", prUrl, "--repo", nwo, "--title", title, "--body-file", bodyFile]);
      if (edit.code !== 0) log(`Couldn't refresh the existing PR body (gh pr edit exited ${edit.code}): ${edit.stderr || edit.stdout}`, "warn");
      else log("Refreshed the existing PR's description with this run's tables & notes.");
    }
  } else {
    throw new Error("gh pr create failed:\n" + (create.stderr || create.stdout));
  }

  emit("done", { prUrl, changed: true, branch, title, notes, disposition: gemDisposition, blocked: blockedPkgs });
  return { prUrl, changed: true, title, notes, disposition: gemDisposition, blocked: blockedPkgs };
}

function upgradeBody(repo, upgrade, notes) {
  return [
    `## ⚠ Runtime upgrade: ${upgrade.id} ${upgrade.from} → ${upgrade.to}`,
    ``,
    `The pinned **${upgrade.id} ${upgrade.from}** is **end-of-life / unsupported**. This PR rewrites the ` +
      `version pin to **${upgrade.to}** — the smallest safe jump back into support${upgrade.lts ? " (an LTS line)" : ""} — ` +
      `and regenerates lockfiles under it.`,
    ``,
    `> ⚠️ **A runtime version bump is likely BREAKING.** Expect CI to flag incompatibilities ` +
      `(deprecated APIs, dependencies needing their own bumps). Opened as a draft on purpose — review, let the ` +
      `fixes land, then merge.`,
    ``,
    notes && notes.length ? `### Notes\n\n${notes.map((n) => "- " + n).join("\n")}\n` : "",
    `---`,
    `_Generated for SOC 2 Type 2 dependency-maintenance evidence by the Dependency Dashboard._`,
    ``,
  ].join("\n");
}

function prBody(repo, notes, blocked) {
  const pkgs = repo.packages || [];
  blocked = blocked || [];
  const fmtBump = (p) => {
    if (p.majorRequired) return "**major (required)**";
    return p.bump === "major" || p.bump === "minor" ? `**${p.bump}**` : p.bump || "—";
  };
  const rows = pkgs
    .map((p) => {
      const to = p.target || p.patched || "";
      return `| ${p.severity} | ${p.ecosystem} | \`${p.pkg}\` | ${p.installed || "—"} | ${to ? "→ " + to : "—"} | ${fmtBump(p)} | ${p.ghsa || ""} |`;
    })
    .join("\n");

  // A repo's forced majors (no same-major fix) are excluded from the auto-update and
  // listed separately so a human can opt in.
  const forcedMajors = pkgs.filter((p) => p.majorRequired);
  const majorNote = forcedMajors.length
    ? [
        ``,
        `### ⚠ Major upgrades required — not included here (${forcedMajors.length})`,
        ``,
        `These advisories have **no same-major security fix**, so resolving them needs a major ` +
          `version bump (likely breaking). They were **left out** of this lockfile-only PR — review and opt in deliberately:`,
        ``,
        `| Ecosystem | Package | ${"Current"} → Required | Advisory |`,
        `| --- | --- | --- | --- |`,
        ...forcedMajors.map((p) => `| ${p.ecosystem} | \`${p.pkg}\` | ${p.installed || "—"} → ${p.target || p.patched || "?"} | ${p.ghsa || ""} |`),
      ].join("\n")
    : "";

  // Packages with a same-major security fix that the lockfile-only update still
  // couldn't reach — a manifest/parent constraint caps them. Distinct from the
  // major-required table above (those need a deliberate major bump, not a constraint
  // tweak). Surfaced so the PR never silently leaves a flagged advisory unfixed.
  const blockedNote = blocked.length
    ? [
        ``,
        `### 🚫 Blocked — needs a manifest change (${blocked.length})`,
        ``,
        `These advisories have a **same-major** fix, but a lockfile-only update can't reach it: a ` +
          `\`Gemfile\`/\`package.json\` constraint or a parent dependency's range caps the package below its ` +
          `patched floor. Bump the blocking constraint (or the parent that pins it), then re-run.`,
        ``,
        `| Ecosystem | Package | Resolved | Needs ≥ | Why it's blocked |`,
        `| --- | --- | --- | --- | --- |`,
        ...blocked.map((b) => `| ${b.ecosystem} | \`${b.pkg}\` | ${b.resolved || "—"} | ${b.floor} | ${b.reason} |`),
      ].join("\n")
    : "";

  return [
    `## SOC 2 dependency remediation`,
    ``,
    `Automated, **lockfile-only** updates generated by the Dependency Dashboard, ` +
      `targeting the open Dependabot advisories below.`,
    ``,
    `> ⚠️ **Review before merge.** This branch updates lockfiles only and does **not** run a full install or your test suite. ` +
      `Let CI run, confirm the app builds and tests pass, then merge. Opened as a draft on purpose.`,
    ``,
    `### Advisories targeted (${pkgs.length})`,
    ``,
    `**Bump** flags the change type — **major**/**minor** are worth a closer look; patch is typically non-breaking. ` +
      `(\`From\` is the version on \`${repo.defaultBranch || "the default branch"}\`; \`To\` is the advisory's patched floor — the resolved version may be higher.)`,
    ``,
    `| Severity | Ecosystem | Package | From | To | Bump | Advisory |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    rows || `| — | — | — | — | — | — | — |`,
    majorNote,
    blockedNote,
    ``,
    notes.length ? `### Notes\n\n${notes.map((n) => "- " + n).join("\n")}\n` : "",
    `---`,
    `_Generated for SOC 2 Type 2 dependency-maintenance evidence. Branch is regenerated per-day; ` +
      `a same-day re-run force-updates it with a lease._`,
    ``,
  ].join("\n");
}

module.exports = { createUpdatePR, readRubyVersion, readNodeVersion, readGoVersion, readPhpVersion, miseRubyBundle, maxPatchedByPkg, applyJsOverrides };
