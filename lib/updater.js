"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { run, runOrThrow, stream, todayStamp } = require("./exec");
const { vulnerablePackagesByEcosystem } = require("./github");
const { jobContext } = require("./job");
const { writePins } = require("./eol");

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
    if (!p.pkg || !p.patched) continue;
    const cur = m.get(p.pkg);
    if (!cur || cmpVer(p.patched, cur) > 0) m.set(p.pkg, p.patched);
  }
  return m;
}

// Force each flagged package to ">=patched <nextMajor" via the package manager's
// override mechanism — npm `overrides`, pnpm `pnpm.overrides`, or yarn `resolutions`.
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

  // ---- 3.1 npm-ecosystem overrides fallback ------------------------------
  // If the gentle update above moved NOTHING (the common case — most npm advisories
  // are transitive deps a targeted `update` can't reach), force every flagged package
  // to its patched version via overrides/resolutions and regenerate the lockfile. That
  // produces a real, comprehensive draft PR; CI is the gate, since a forced transitive
  // bump can break a dependent.
  const jsLock =
    has(dir, "pnpm-lock.yaml") || has(dir, "yarn.lock") || has(dir, "package-lock.json") || has(dir, "npm-shrinkwrap.json");
  if (jsLock && has(dir, "package.json") && (byEco["npm"] || []).length) {
    step("Transitive overrides check");
    await stageIntendedChanges(dir, sh, log);
    const unchanged = (await run("git", ["-C", dir, "diff", "--cached", "--quiet"])).code === 0;
    if (!unchanged) {
      log("The targeted update already changed the lockfile — overrides not needed.", "info");
    }
    if (unchanged) {
      // NOTE: byEco["npm"] is an array of package-name STRINGS; maxPatchedByPkg needs
      // the advisory OBJECTS ({pkg, patched}). Pass the filtered packages, not byEco.
      const patchedByPkg = maxPatchedByPkg((repo.packages || []).filter((p) => p.ecosystem === "npm"));
      if (patchedByPkg.size) {
        const field = applyJsOverrides(dir, patchedByPkg);
        if (!field) {
          notes.push(`Couldn't read package.json to add overrides for ${patchedByPkg.size} flagged package(s).`);
        } else {
          log(`Targeted update changed nothing — forcing ${patchedByPkg.size} flagged package(s) to patched via ${field} (reaches transitive deps).`, "warn");
          let rc;
          if (has(dir, "pnpm-lock.yaml")) rc = await nodeCmd("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"]);
          else if (has(dir, "yarn.lock")) rc = await nodeCmd("yarn", ["install", "--mode=update-lockfile"]);
          else rc = await nodeCmd("npm", ["install", "--package-lock-only"]);
          if (rc === null) {
            notes.push(`Wrote ${field} for ${patchedByPkg.size} flagged package(s), but no Node toolchain was available to regenerate the lockfile.`);
          } else if (rc !== 0) {
            notes.push(
              `Added ${field} pinning ${patchedByPkg.size} flagged package(s) to patched versions, but the lockfile regen exited ${rc} — ` +
                `a forced version likely conflicts with a peer/parent. The conflict is in the log above; the override list is staged in package.json.`
            );
          } else {
            notes.push(
              `Forced ${patchedByPkg.size} flagged package(s) to their patched versions via \`${field}\` — this reaches transitive deps a ` +
                `normal update can't. Opens a draft PR; let CI run, since a forced transitive bump can break a dependent.`
            );
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
    emit("done", { prUrl: null, changed: false, branch, notes, disposition: gemDisposition });
    return { prUrl: null, changed: false, notes, disposition: gemDisposition };
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
  const body = upgrade ? upgradeBody(repo, upgrade, notes) : prBody(repo, notes);
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
    log("A PR already exists for this branch — fetching its URL.", "warn");
    const found = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--json", "url", "--jq", ".[0].url"]);
    prUrl = found.stdout.trim() || null;
  } else {
    throw new Error("gh pr create failed:\n" + (create.stderr || create.stdout));
  }

  emit("done", { prUrl, changed: true, branch, notes, disposition: gemDisposition });
  return { prUrl, changed: true, notes, disposition: gemDisposition };
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

function prBody(repo, notes) {
  const rows = (repo.packages || [])
    .map(
      (p) =>
        `| ${p.severity} | ${p.ecosystem} | \`${p.pkg}\` | ${p.patched ? "→ " + p.patched : "—"} | ${p.ghsa || ""} |`
    )
    .join("\n");

  return [
    `## SOC 2 dependency remediation`,
    ``,
    `Automated, **lockfile-only** updates generated by the Dependency Dashboard, ` +
      `targeting the open Dependabot advisories below.`,
    ``,
    `> ⚠️ **Review before merge.** This branch updates lockfiles only and does **not** run a full install or your test suite. ` +
      `Let CI run, confirm the app builds and tests pass, then merge. Opened as a draft on purpose.`,
    ``,
    `### Advisories targeted (${(repo.packages || []).length})`,
    ``,
    `| Severity | Ecosystem | Package | Patched | Advisory |`,
    `| --- | --- | --- | --- | --- |`,
    rows || `| — | — | — | — | — |`,
    ``,
    notes.length ? `### Notes\n\n${notes.map((n) => "- " + n).join("\n")}\n` : "",
    `---`,
    `_Generated for SOC 2 Type 2 dependency-maintenance evidence. Branch is regenerated per-day; ` +
      `a same-day re-run force-updates it with a lease._`,
    ``,
  ].join("\n");
}

module.exports = { createUpdatePR, readRubyVersion, readNodeVersion, readGoVersion, readPhpVersion, miseRubyBundle, maxPatchedByPkg, applyJsOverrides };
