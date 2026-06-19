"use strict";

// Consolidate a stack of already-approved dependency-update PRs into ONE "release" PR.
//
// Why this exists: every approved dep PR in a stack mutates the SAME lockfiles
// (`package-lock.json` / `Gemfile.lock` …). Merging them one-by-one means each merge
// invalidates the rest (rebase storm), and even a textually clean lockfile auto-merge is
// semantically a frankenstate. Doing it once — merge every branch onto one release branch,
// then REGENERATE the lockfiles so all versions coexist, then test — resolves conflicts a
// single time in full context and CIs the exact state that ships.
//
// Shape mirrors lib/upgrader.js's clone→branch→Claude→commit→push→PR flow. The server
// orchestrates the deterministic git plumbing (branch, fetch, attempt clean merges) and
// hands the hard part (resolve conflicting merges + regenerate lockfiles + test) to one
// high-effort headless Claude session. Then the dashboard pushes, opens the single PR, and
// closes the originals — pointing each at the rollup.

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { run, stream, todayStamp } = require("./exec");
const { jobContext, isJunkPath } = require("./job");
const { runClaude } = require("./fixer");

const exists = (p) => fsSync.existsSync(p);
const slug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

// Effort/model/timeout for the rollup session — a deep, conflict-heavy task, so MAX effort
// by default. Read from config.claudeRollup with sensible fallbacks (mirrors sessionOpts).
function sessionOpts(cfgBlock) {
  const c = cfgBlock || {};
  return {
    mode: c.permissionMode || "auto",
    effort: c.effort || "max",
    model: c.model || undefined,
    timeoutMin: c.timeoutMinutes || 45,
  };
}

// Make sure the repo is cloned (full, so we can push). Mirrors upgrader.ensureClone.
async function ensureClone({ nwo, dir, workRoot, log, onLn }) {
  if (exists(path.join(dir, ".git"))) return;
  if (exists(dir)) await fs.rm(dir, { recursive: true, force: true });
  log(`$ gh repo clone ${nwo}`);
  await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
}

function rollupPrompt(nwo, base, branch, { merged, deferred, prs }) {
  const lines = [
    `This is \`${nwo}\` — consolidating ${prs.length} already-approved dependency-update PRs into ONE release branch \`${branch}\` (cut from \`${base}\`, already checked out here). The point of a rollup is to resolve conflicts and regenerate lockfiles ONCE, in the context of all the work together, so the result is a single coherent PR with every upgrade.`,
    ``,
    `## Already merged cleanly`,
    merged.length ? merged.map((p) => `- PR #${p.number} — ${p.title || p.headRefName}`).join("\n") : "(none)",
    ``,
    `## Still need merging (they conflicted — do these now)`,
    deferred.length
      ? deferred
          .map((p) => `- PR #${p.number} (${p.title || p.headRefName}): \`git merge --no-edit refs/rollup/pr-${p.number}\``)
          .join("\n")
      : "(none — every branch merged cleanly)",
    deferred.length
      ? `\nFor each: run the merge, resolve conflicts by KEEPING BOTH upgrades (every PR's version bump must survive — never drop one to satisfy the other), then \`git add\` the resolved files and commit the merge.`
      : ``,
    ``,
    `## Critical: regenerate the lockfiles`,
    `Every one of these PRs bumps dependencies, so after the merges the lockfile(s) (\`package-lock.json\` / \`yarn.lock\` / \`pnpm-lock.yaml\` / \`Gemfile.lock\`) are an incoherent blend — even where git merged them without a textual conflict. REGENERATE them from the manifests using the repo's pinned toolchain through mise:`,
    `- npm: \`mise exec -- npm install\` (or \`yarn install\` / \`pnpm install\` to match the repo's lockfile)`,
    `- ruby: \`mise exec -- bundle install\``,
    `Run \`mise install\` first if the pinned runtime isn't present. After regenerating, confirm every upgraded package resolves at/above its intended version in the lockfile.`,
    ``,
    `## Build & test`,
    `Get the test suite green where feasible — and pay special attention to breakage the COMBINATION of upgrades introduces (interactions no single PR's CI could have caught, since each was tested in isolation). If a failure is clearly pre-existing and unrelated, leave it and say so.`,
    ``,
    `## Finish`,
    `\`git add\` ONLY dependency manifests, lockfiles, and the code/tests the upgrades required — never tracker/state files (\`.beads/\`, editor configs, \`.DS_Store\`). Commit any uncommitted resolution with a concise message like \`chore(deps): consolidate ${prs.length} approved dependency upgrades\`. Do NOT push or open a PR — the dashboard does that.`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

/**
 * Consolidate the given approved PRs into one release PR.
 * @param {{config, repo, prs:Array<{number,headRefName,url,title}>, emit}} a
 */
async function createRollupPR({ config, repo, prs, emit }) {
  const ctx = await jobContext({ config, repo, emit });
  const { nwo, dir, log, step, sh } = ctx;
  const base = repo.defaultBranch || "main";
  const branch = `release/deps-${todayStamp()}`;
  const list = (prs || []).filter((p) => p && p.number && p.headRefName);
  if (list.length < 2) {
    log("Need at least two approved PRs to roll up — nothing to do.", "warn");
    emit("done", { prUrl: null, changed: false });
    return { prUrl: null, changed: false };
  }

  // A release PR is already open for today's branch — don't start a second session.
  const existing = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--state", "open", "--json", "url,number"]);
  let exPr = null;
  try { exPr = JSON.parse(existing.stdout.trim() || "[]")[0] || null; } catch { /* none */ }
  if (exPr && exPr.url) {
    log(`A release PR is already open for ${branch} (#${exPr.number}) — skipping. Close it to regenerate.`, "warn");
    emit("done", { prUrl: exPr.url, changed: false, branch });
    return { prUrl: exPr.url, changed: false, branch };
  }

  step("Cloning");
  await ensureClone(ctx);

  step("Branching");
  await run("git", ["-C", dir, "fetch", "origin", base]).catch(() => {});
  await run("git", ["-C", dir, "checkout", base]).catch(() => {});
  await run("git", ["-C", dir, "reset", "--hard", `origin/${base}`]).catch(() => {});
  log(`$ git switch -C ${branch}`);
  await sh("git", ["switch", "-C", branch]);
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  // Fetch each PR head into a stable local ref (so Claude can merge the deferred ones by
  // name), then attempt the merge. Clean merges land deterministically here; any conflict
  // is aborted and deferred to the Claude session, which resolves them all at once.
  step("Merging approved branches");
  const merged = [];
  const deferred = [];
  for (const pr of list) {
    const localRef = `refs/rollup/pr-${pr.number}`;
    const f = await run("git", ["-C", dir, "fetch", "origin", `+${pr.headRefName}:${localRef}`]);
    if (f.code !== 0) {
      log(`⚠ Couldn't fetch PR #${pr.number} (${pr.headRefName}) — skipping it from this rollup.`, "warn");
      continue;
    }
    const m = await run("git", ["-C", dir, "merge", "--no-edit", localRef]);
    if (m.code === 0) {
      merged.push(pr);
      log(`✓ merged PR #${pr.number} — ${pr.title || pr.headRefName}`);
    } else {
      await run("git", ["-C", dir, "merge", "--abort"]).catch(() => {});
      deferred.push(pr);
      log(`⚠ PR #${pr.number} conflicts — deferring its merge to the Claude session.`, "warn");
    }
  }
  if (!merged.length && !deferred.length) {
    log("None of the approved PR branches could be fetched — aborting rollup.", "warn");
    emit("done", { prUrl: null, changed: false });
    return { prUrl: null, changed: false };
  }

  // Always run the session: it merges the deferred branches AND regenerates the lockfiles
  // (which a clean git merge leaves incoherent), then runs the suite on the combined state.
  step("Claude session");
  const session = sessionOpts(config.claudeRollup);
  log(`$ claude -p --permission-mode ${session.mode} --effort ${session.effort}${session.model ? ` --model ${session.model}` : ""}`, "warn");
  await runClaude({ prompt: rollupPrompt(nwo, base, branch, { merged, deferred, prs: list }), cwd: dir, log, ...session });

  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
  const junkStaged = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junkStaged.length) {
    log(`Excluding tracker/state file(s) from the commit: ${junkStaged.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junkStaged]);
  }
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) {
    await run("git", ["-C", dir, "commit", "-m", `chore(deps): consolidate ${list.length} approved dependency upgrades`]);
  }
  const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  if (head === before) {
    log("Rollup produced no commits over the base — nothing to open.", "warn");
    emit("done", { prUrl: null, changed: false });
    return { prUrl: null, changed: false };
  }

  step("Pushing branch");
  log(`$ git push --force-with-lease -u origin ${branch}`);
  const pc = await sh("git", ["push", "--force-with-lease", "-u", "origin", branch]);
  if (pc !== 0) await sh("git", ["push", "-u", "origin", branch]);

  step("Opening release PR");
  const refs = list.map((p) => `#${p.number}`).join(" ");
  const bodyLines = [
    `## Dependency release rollup — ${todayStamp()}`,
    ``,
    `Consolidates ${list.length} already-approved dependency-update PRs into a single coherent merge: conflicts resolved and lockfiles regenerated once, with every upgrade present together, then the suite run on the combined state.`,
    ``,
    `### Rolled-up PRs`,
    ...list.map((p) => `- #${p.number} — ${p.title || p.headRefName}`),
    ``,
    deferred.length
      ? `Branches that conflicted and were merged with resolution: ${deferred.map((p) => `#${p.number}`).join(", ")}.`
      : `All branches merged cleanly; lockfiles were regenerated for coherence.`,
    ``,
    `> ⚠️ **Squash-merge this PR** so \`${base}\` gets one tidy remediation commit citing every upgrade. The original PRs (${refs}) are being closed in favor of this one.`,
  ];
  const bodyFile = path.join(os.tmpdir(), `hw-rollup-${slug(nwo)}-${slug(branch)}.md`);
  await fs.writeFile(bodyFile, bodyLines.join("\n"), "utf8");
  const title = `chore(deps): security/dependency release rollup — ${todayStamp()} (${list.length} PRs)`;
  const prArgs = ["pr", "create", "--repo", nwo, "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile];
  if (config.draftPRs) prArgs.push("--draft");
  const create = await run("gh", prArgs);
  let prUrl = null;
  if (create.code === 0) {
    prUrl = (create.stdout.trim().match(/https?:\/\/\S+/) || [])[0] || create.stdout.trim();
    log(create.stdout.trim());
  } else if (/already exists/i.test(create.stderr)) {
    const found = await run("gh", ["pr", "list", "--repo", nwo, "--head", branch, "--json", "url", "--jq", ".[0].url"]);
    prUrl = found.stdout.trim() || null;
    if (prUrl) await run("gh", ["pr", "edit", prUrl, "--repo", nwo, "--title", title, "--body-file", bodyFile]);
  } else {
    throw new Error("gh pr create failed:\n" + (create.stderr || create.stdout));
  }
  if (!prUrl) {
    emit("done", { prUrl: null, changed: false });
    return { prUrl: null, changed: false };
  }

  // Close the originals now (per the chosen flow — close on rollup open), each pointing at
  // the rollup so the trail is clear. Best-effort: a close failure shouldn't sink the job.
  step("Closing original PRs");
  const closedPRs = [];
  const comment = `Consolidated into ${prUrl} for a single coherent merge — review & squash-merge there.`;
  for (const pr of list) {
    const c = await run("gh", ["pr", "close", String(pr.number), "--repo", nwo, "--comment", comment]);
    if (c.code === 0) { closedPRs.push(pr.url); log(`✓ closed PR #${pr.number} → ${prUrl}`); }
    else log(`⚠ couldn't close PR #${pr.number}: ${(c.stderr || "").trim()}`, "warn");
  }

  const out = { prUrl, title, branch, changed: true, closedPRs, rolledUp: list.length };
  log(`\nRollup PR opened (${list.length} PRs consolidated, ${closedPRs.length} closed): ${prUrl}`);
  emit("done", { ...out });
  return out;
}

function rebasePrompt(nwo, base, branch) {
  return [
    `This is \`${nwo}\` — bring the open PR branch \`${branch}\` up to date with its base \`${base}\` (both fetched; you're on \`${branch}\`, and a merge of the base may already be in progress with conflicts staged).`,
    ``,
    `## What to do`,
    `- If no merge is in progress, start one: \`git merge --no-edit origin/${base}\`.`,
    `- Resolve any conflicts: keep THIS branch's dependency upgrade intact while taking the base's other changes. Never drop this branch's bump to satisfy the merge.`,
    `- This branch changes dependencies, so the lockfile(s) (\`package-lock.json\` / \`yarn.lock\` / \`pnpm-lock.yaml\` / \`Gemfile.lock\`) must stay coherent with the merged base — REGENERATE them from the manifests via the repo's pinned toolchain through mise: \`mise exec -- npm install\` (or yarn/pnpm) / \`mise exec -- bundle install\`. Run \`mise install\` first if the pinned runtime isn't present.`,
    `- Get the test suite green where feasible; note any clearly pre-existing, unrelated failure.`,
    ``,
    `## Finish`,
    `\`git add\` ONLY dependency manifests, lockfiles, and the code/tests the merge required — never tracker/state files (\`.beads/\`, editor configs, \`.DS_Store\`). Commit any uncommitted resolution with a concise message like \`chore(deps): merge ${base} and regenerate lockfile\`. Do NOT push — the dashboard does that.`,
  ].join("\n");
}

/**
 * Bring one open PR branch up to date with its base: merge the base in, regenerate the
 * lockfiles, resolve conflicts, push. Used by the per-PR "Rebase / Update branch" action.
 * @param {{config, repo, number, branch, emit}} a
 */
async function createRebasePR({ config, repo, number, branch, emit }) {
  const ctx = await jobContext({ config, repo, emit });
  const { nwo, dir, log, step, sh } = ctx;
  const base = repo.defaultBranch || "main";
  if (!branch) {
    log(`Couldn't determine the head branch for PR #${number} — nothing to rebase.`, "warn");
    emit("done", { changed: false, number });
    return { changed: false, number };
  }

  step("Cloning");
  await ensureClone(ctx);

  step("Fetching base + PR branch");
  await run("git", ["-C", dir, "fetch", "origin", base]).catch(() => {});
  const f = await run("git", ["-C", dir, "fetch", "origin", branch]);
  if (f.code !== 0) throw new Error(`Couldn't fetch ${branch}: ${(f.stderr || "").trim()}`);
  await sh("git", ["checkout", "-B", branch, "FETCH_HEAD"]);
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  // Attempt the base merge here; a conflict is LEFT in progress for Claude to resolve (a
  // clean merge is auto-committed, and Claude then just regenerates the lockfiles).
  step("Merging base");
  const m = await run("git", ["-C", dir, "merge", "--no-edit", `origin/${base}`]);
  if (m.code === 0) log(`Merged origin/${base} cleanly — regenerating lockfiles for coherence.`);
  else log(`origin/${base} conflicts with this branch — the session will resolve them.`, "warn");

  step("Claude session");
  const session = sessionOpts(config.claudeRebase || config.claudeRollup);
  log(`$ claude -p --permission-mode ${session.mode} --effort ${session.effort}${session.model ? ` --model ${session.model}` : ""}`, "warn");
  await runClaude({ prompt: rebasePrompt(nwo, base, branch), cwd: dir, log, ...session });

  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
  const junkStaged = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junkStaged.length) {
    log(`Excluding tracker/state file(s) from the commit: ${junkStaged.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junkStaged]);
  }
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) await run("git", ["-C", dir, "commit", "-m", `chore(deps): merge ${base} and regenerate lockfile`]);
  const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  if (head === before) {
    log("Branch was already up to date — no changes to push.", "warn");
    emit("done", { changed: false, number });
    return { changed: false, number };
  }

  step("Pushing branch");
  log(`$ git push --force-with-lease origin ${branch}`);
  const pc = await sh("git", ["push", "--force-with-lease", "origin", branch]);
  if (pc !== 0) await sh("git", ["push", "origin", branch]);

  log(`\nRebased PR #${number} onto ${base} and pushed — CI will re-run.`);
  emit("done", { changed: true, number });
  return { changed: true, number };
}

module.exports = { createRollupPR, rollupPrompt, createRebasePR, rebasePrompt };
