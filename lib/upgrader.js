"use strict";

// Drive headless Claude Code sessions to perform the two remediations a lockfile-only
// update CAN'T do, both at high reasoning effort:
//   1. UNBLOCK — flagged deps whose same-major security fix is capped by a manifest /
//      parent-dependency constraint. One session raises the blocking constraint (or
//      bumps the parent), regenerates the lockfile, and opens ONE PR.
//   2. MAJOR  — advisories whose only fix crosses a major (breaking). One session +
//      branch + PR PER package, so each breaking upgrade is independently reviewable
//      and CI-gated. createMajorUpgradePRs loops and returns every PR it opened.
// Both mirror createConstraintBumpPR's clone→branch→Claude→commit→push→PR shape.

const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { run, stream, todayStamp } = require("./exec");
const { jobContext, isJunkPath } = require("./job");
const { runClaude } = require("./fixer");

const exists = (p) => fsSync.existsSync(p);
const slug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

// Loose version compare (numeric segments; non-numeric → 0). >0 ⇒ a is newer.
function cmpLoose(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Collapse the flagged-package list to one entry per package: the same package can carry
// several advisories (each its own row), but it's a SINGLE upgrade — one branch + PR.
// Keep the highest required version and gather every advisory id so the PR cites them all.
function dedupeMajors(list) {
  const byPkg = new Map();
  for (const p of list || []) {
    const key = `${p.ecosystem}::${p.pkg}`;
    const cur = byPkg.get(key);
    if (!cur) {
      byPkg.set(key, { ...p, ghsas: p.ghsa ? [p.ghsa] : [] });
      continue;
    }
    if (p.ghsa && !cur.ghsas.includes(p.ghsa)) cur.ghsas.push(p.ghsa);
    if (cmpLoose(p.target || p.patched || "", cur.target || cur.patched || "") > 0) {
      cur.target = p.target;
      cur.patched = p.patched;
    }
  }
  return [...byPkg.values()];
}

// Effort/model/timeout for a deep session, read from a config block (claudeUnblock /
// claudeMajor) with a sensible default. Both default to MAX effort — these are the
// hard, breaking changes the user opts into deliberately.
function sessionOpts(cfgBlock, defTimeout) {
  const c = cfgBlock || {};
  return {
    mode: c.permissionMode || "auto",
    effort: c.effort || "max",
    model: c.model || undefined,
    timeoutMin: c.timeoutMinutes || defTimeout,
  };
}

// Reset the working clone to a fresh `base`, cut `branch`, run one Claude session, then
// commit whatever it produced (minus tracker/state junk). Returns { prUrl, changed }.
// `before` is captured post-branch so we can tell whether Claude actually changed anything.
async function openClaudePR(ctx) {
  const { config, nwo, dir, base, branch, prompt, session, title, bodyLines, commitMsg, log, step, sh } = ctx;

  // If an open PR already exists for this branch, the work is already done and the CI
  // auto-fixer iterates on it — re-running would reset the branch (wiping that work) and
  // burn another high-effort session. Skip and return the existing PR. (Close it first to
  // regenerate.) The per-day branch makes a same-day re-click land on the same PR.
  const existing = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--state", "open", "--json", "url,title,number"]);
  let exPr = null;
  try { exPr = JSON.parse(existing.stdout.trim() || "[]")[0] || null; } catch { /* no PR */ }
  if (exPr && exPr.url) {
    log(`An open PR already exists for ${branch} (#${exPr.number}) — skipping the session; the CI auto-fixer will keep iterating on it. Close it to regenerate.`, "warn");
    return { prUrl: exPr.url, changed: false, branch, title: exPr.title || title, skipped: true };
  }

  step("Branching");
  await run("git", ["-C", dir, "fetch", "origin", base]).catch(() => {});
  await run("git", ["-C", dir, "checkout", base]).catch(() => {});
  await run("git", ["-C", dir, "reset", "--hard", `origin/${base}`]).catch(() => {});
  log(`$ git switch -C ${branch}`);
  await sh("git", ["switch", "-C", branch]);
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  step("Claude session");
  log(`$ claude -p --permission-mode ${session.mode} --effort ${session.effort}${session.model ? ` --model ${session.model}` : ""}`, "warn");
  await runClaude({ prompt, cwd: dir, log, ...session });

  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
  const junkStaged = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junkStaged.length) {
    log(`Excluding tracker/state file(s) from the commit: ${junkStaged.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junkStaged]);
  }
  const afterAdd = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  let committed = afterAdd !== before; // Claude may have committed itself
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (!committed && staged.code !== 0) {
    await run("git", ["-C", dir, "commit", "-m", commitMsg]);
    committed = true;
  }
  if (!committed) {
    log("Claude produced no change for this upgrade — needs a manual look.", "warn");
    return { prUrl: null, changed: false, branch, title };
  }
  const touched = (await run("git", ["-C", dir, "diff", "--name-only", `${before}..HEAD`])).stdout.split("\n").filter(Boolean);
  log(`PR will contain ${touched.length} file(s): ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? ", …" : ""}`);
  const junkCommitted = touched.filter(isJunkPath);
  if (junkCommitted.length) log(`⚠ Commit includes tracker/state file(s): ${junkCommitted.join(", ")} — review the PR diff.`, "warn");

  step("Pushing branch");
  log(`$ git push --force-with-lease -u origin ${branch}`);
  const pc = await sh("git", ["push", "--force-with-lease", "-u", "origin", branch]);
  if (pc !== 0) await sh("git", ["push", "-u", "origin", branch]);

  step("Opening pull request");
  const bodyFile = path.join(os.tmpdir(), `hw-upg-${slug(nwo)}-${slug(branch)}.md`);
  await fs.writeFile(bodyFile, bodyLines.join("\n"), "utf8");
  const prArgs = ["pr", "create", "--repo", nwo, "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile];
  if (config.draftPRs) prArgs.push("--draft");
  const create = await run("gh", prArgs);
  let prUrl = null;
  if (create.code === 0) {
    prUrl = (create.stdout.trim().match(/https?:\/\/\S+/) || [])[0] || create.stdout.trim();
    log(create.stdout.trim());
  } else if (/already exists/i.test(create.stderr)) {
    log("A PR already exists for this branch — refreshing its body.", "warn");
    const found = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--json", "url", "--jq", ".[0].url"]);
    prUrl = found.stdout.trim() || null;
    if (prUrl) await run("gh", ["pr", "edit", prUrl, "--repo", nwo, "--title", title, "--body-file", bodyFile]);
  } else {
    throw new Error("gh pr create failed:\n" + (create.stderr || create.stdout));
  }
  return { prUrl, changed: true, branch, title };
}

// Make sure the repo is cloned (full, so we can push). Mirrors createConstraintBumpPR.
async function ensureClone({ nwo, dir, workRoot, log, onLn }) {
  if (exists(path.join(dir, ".git"))) return;
  if (exists(dir)) await fs.rm(dir, { recursive: true, force: true });
  log(`$ gh repo clone ${nwo}`);
  await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
}

function unblockPrompt(nwo, branch, blocked) {
  const lines = (blocked || [])
    .map((b) => `- \`${b.pkg}\` (${b.ecosystem}) resolves to ${b.resolved || "below floor"} but needs **≥ ${b.floor}** — ${b.reason || "capped by a constraint"}`)
    .join("\n");
  return [
    `This is \`${nwo}\` (branch \`${branch}\`, already checked out here). A lockfile-only update FAILED to patch the security advisories below: each has a **same-major** fix, but a \`package.json\`/\`Gemfile\` constraint or a parent dependency's range caps the package below its patched floor. Raise the blocking constraint so the patched version is admissible — staying within the current major.`,
    ``,
    `## Blocked advisories (all have a same-major fix)`,
    lines || "(inspect the manifests/lockfiles — a transitive dep is pinned below its patched floor)",
    ``,
    `## How to fix`,
    `- For each: find what pins it below the floor — usually a PARENT dependency's version range. Bump that parent (or add/raise an \`overrides\`/\`resolutions\` entry in \`package.json\`, or a Gemfile constraint) to the smallest version that admits the patched floor. Prefer bumping the real parent over a forced override when feasible.`,
    `- **Stay same-major** for the flagged package itself — do NOT cross its major (that's a separate, deliberate upgrade). Pulling a parent to a newer major is OK only if required to admit the same-major patch and it builds.`,
    `- Regenerate the lockfile via the repo's pinned toolchain through mise: \`mise exec -- npm install\` / \`yarn install\` / \`pnpm install --lockfile-only\`, or \`mise exec -- bundle install\`. Run \`mise install\` first if the pinned runtime isn't present.`,
    `- Get the build/tests green where feasible; note any clearly pre-existing, unrelated failure.`,
    `- After your change, double-check each flagged package now resolves at/above its floor in the lockfile.`,
    ``,
    `## Finish`,
    `\`git add\` ONLY the files your fix changed (manifests + lockfiles, and any code/test a parent bump required) — never tool/tracker state files (\`.beads/\`, editor configs, \`.DS_Store\`). Commit with a concise message like \`chore(deps): unblock constraint-capped security patches\`. Do NOT push or open a PR — the dashboard does that.`,
  ].join("\n");
}

function majorPrompt(nwo, branch, p) {
  const to = p.target || p.patched || "the patched major";
  return [
    `This is \`${nwo}\` (branch \`${branch}\`, already checked out here). Perform a single **MAJOR, breaking** dependency upgrade to clear a security advisory that has no same-major fix.`,
    ``,
    `## The upgrade`,
    `- Package: \`${p.pkg}\` (${p.ecosystem})`,
    `- From ${p.installed || "the installed version"} → **${to}** or higher (a major version — expect breaking API changes).`,
    p.ghsa ? `- Advisory: ${p.ghsa}` : ``,
    ``,
    `## How to do it`,
    `- Raise the constraint for \`${p.pkg}\` in the manifest (\`package.json\` / \`Gemfile\` / \`*.gemspec\`) to admit \`${to}\`, then install via the repo's pinned toolchain through mise (\`mise exec -- bundle install\` or \`mise exec -- npm install\`/\`yarn\`/\`pnpm\`). Run \`mise install\` first if the pinned runtime isn't present.`,
    `- Update THIS repo's own code and tests for the breaking changes the upgrade introduces — read the package's CHANGELOG/upgrade guide as needed. Keep the diff focused on what the upgrade requires; do not refactor unrelated code or bump other dependencies beyond what's needed to make this one resolve.`,
    `- Get the test suite green where feasible. If a failure is clearly pre-existing and unrelated, leave it and say so.`,
    ``,
    `## Finish`,
    `\`git add\` ONLY the files your upgrade changed — never tool/tracker state files (\`.beads/\`, editor configs, \`.DS_Store\`). Commit with a concise message like \`chore(deps): upgrade ${p.pkg} to ${to} (major, security)\`. Do NOT push or open a PR — the dashboard does that.`,
  ].filter((l) => l !== "").join("\n");
}

/**
 * UNBLOCK: one headless session + one PR that raises the manifest/parent constraints
 * capping same-major security patches. `blocked` is the repo's blocked-survivor list
 * ({ ecosystem, pkg, resolved, floor, reason }).
 * @param {{config, repo, blocked, emit}} a
 */
async function createUnblockPR({ config, repo, blocked, emit }) {
  const ctx = await jobContext({ config, repo, emit });
  const { nwo, dir, log, step } = ctx;
  const base = repo.defaultBranch || "main";
  const branch = `dependency-unblock/soc2-${todayStamp()}`;
  const list = (blocked && blocked.length ? blocked : repo.blocked) || [];
  if (!list.length) {
    log("No blocked advisories to unblock — nothing to do.", "warn");
    emit("done", { prUrl: null, changed: false });
    return { prUrl: null, changed: false };
  }

  step("Cloning");
  await ensureClone(ctx);

  const result = await openClaudePR({
    config, nwo, dir, base, branch, ...ctx,
    prompt: unblockPrompt(nwo, branch, list),
    session: sessionOpts(config.claudeUnblock, 30),
    title: `chore(deps): unblock constraint-capped security patches — ${todayStamp()}`,
    commitMsg: "chore(deps): unblock constraint-capped security patches",
    bodyLines: [
      `## Unblock constraint-capped security patches`,
      ``,
      `A lockfile-only update couldn't reach the patched floor for the packages below — each has a **same-major** fix, but a \`package.json\`/\`Gemfile\` or parent-dependency constraint capped it. This PR raises the blocking constraint(s) (and regenerates the lockfile) so the patches resolve, **without** crossing a major.`,
      ``,
      `### Advisories unblocked`,
      ...list.map((b) => `- \`${b.pkg}\` (${b.ecosystem}) → needs ≥ ${b.floor}${b.resolved ? ` (was ${b.resolved})` : ""}`),
      ``,
      `> ⚠️ Generated by the Dependency Dashboard via a high-effort automated Claude session. A parent-dependency bump can have its own side effects — **review the diff and CI carefully.** Opened as a draft.`,
    ],
  });

  emit("done", { ...result });
  return result;
}

/**
 * MAJOR: one session + branch + PR PER package, so each breaking upgrade is isolated.
 * `packages` is the repo's majorRequired list (annotated with installed/target/ghsa).
 * Returns { prUrls, changed, results } — every PR opened, plus per-package outcomes.
 * @param {{config, repo, packages, emit}} a
 */
async function createMajorUpgradePRs({ config, repo, packages, emit }) {
  const ctx = await jobContext({ config, repo, emit });
  const { nwo, dir, log, step } = ctx;
  const base = repo.defaultBranch || "main";
  const majors = dedupeMajors(packages && packages.length ? packages : (repo.packages || []).filter((p) => p.majorRequired));
  if (!majors.length) {
    log("No major-required advisories to upgrade — nothing to do.", "warn");
    emit("done", { prUrls: [], changed: false, results: [] });
    return { prUrls: [], changed: false, results: [] };
  }

  step("Cloning");
  await ensureClone(ctx);

  const session = sessionOpts(config.claudeMajor, 40);
  const results = [];
  const prUrls = [];
  log(`Upgrading ${majors.length} major version(s), one PR each: ${majors.map((p) => `${p.pkg}→${p.target || p.patched || "?"}`).join(", ")}`, "warn");

  for (let i = 0; i < majors.length; i++) {
    const p = majors[i];
    const to = p.target || p.patched || "next-major";
    const branch = `major-upgrade/${slug(p.ecosystem)}-${slug(p.pkg)}-${slug(to)}-${todayStamp()}`;
    log(`\n── Major upgrade ${i + 1}/${majors.length}: ${p.pkg} ${p.installed || "?"} → ${to} ──`, "warn");
    try {
      const r = await openClaudePR({
        config, nwo, dir, base, branch, ...ctx,
        prompt: majorPrompt(nwo, branch, p),
        session,
        title: `chore(deps): upgrade ${p.pkg} to ${to} (major, security) — ${todayStamp()}`,
        commitMsg: `chore(deps): upgrade ${p.pkg} to ${to} (major, security)`,
        bodyLines: [
          `## Major upgrade: \`${p.pkg}\` ${p.installed || "?"} → ${to}`,
          ``,
          `${(p.ghsas || []).length > 1 ? "These advisories have" : "This advisory has"} **no same-major security fix**, so resolving ${(p.ghsas || []).length > 1 ? "them" : "it"} needs a breaking major upgrade. This PR raises \`${p.pkg}\` and updates this repo's code/tests for the breaking changes.`,
          ``,
          (p.ghsas || []).length ? `Advisor${p.ghsas.length === 1 ? "y" : "ies"}: ${p.ghsas.join(", ")}` : (p.ghsa ? `Advisory: ${p.ghsa}` : ``),
          ``,
          `> ⚠️ Generated by the Dependency Dashboard via a high-effort automated Claude session. A **major** upgrade is likely breaking — **review the diff and CI carefully.** Opened as a draft.`,
        ].filter((l, idx, a) => !(l === "" && a[idx - 1] === "")),
      });
      results.push({ pkg: p.pkg, ecosystem: p.ecosystem, target: to, ...r });
      if (r.prUrl) {
        prUrls.push(r.prUrl);
        log(`✓ ${p.pkg} → ${to}: ${r.prUrl}`);
        // Surface each PR into the dashboard the moment it opens — a fan-out runs one
        // session per major and can take many minutes, so don't make the user wait for
        // the final `done` (or a manual Refresh) to see PRs that already exist.
        emit("pr", { prUrl: r.prUrl, title: r.title || "", branch: r.branch });
      } else log(`• ${p.pkg} → ${to}: no change produced (skipped).`, "warn");
    } catch (e) {
      log(`✗ ${p.pkg} → ${to} failed: ${e.message}`, "warn");
      results.push({ pkg: p.pkg, ecosystem: p.ecosystem, target: to, prUrl: null, changed: false, error: e.message });
    }
  }

  log(`\nDone: opened ${prUrls.length} of ${majors.length} major-upgrade PR(s).`, prUrls.length ? "info" : "warn");
  // Carry per-PR titles so the card shows them live (a refresh would otherwise re-fetch
  // them from GitHub, but these branches aren't matched by branchPrefix).
  const prs = results.filter((r) => r.prUrl).map((r) => ({ url: r.prUrl, title: r.title || "", branch: r.branch }));
  const out = { prUrls, prs, changed: prUrls.length > 0, results };
  emit("done", { ...out });
  return out;
}

module.exports = { createUnblockPR, createMajorUpgradePRs, unblockPrompt, majorPrompt, dedupeMajors };
