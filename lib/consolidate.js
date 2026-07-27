"use strict";

// Two ways — besides a full rollup — to resolve a pile of open dependency PRs that all
// branched off the same base and will collide on the same lockfile when merged one-by-one.
// The user picks per repo (see the consolidation banner in public/app.js); rollup itself
// still lives in lib/rollup.js. The choice is: how many PRs do you want to end up with, and
// how much work now vs. at merge time.
//
//   stack    → N ordered PRs, conflict resolved NOW. Order the PRs (oldest = bottom), merge
//              each onto the one below it + regenerate the lockfile (a high-effort headless
//              session does the conflict-heavy part), then retarget each PR's GitHub base to
//              the branch below so its diff shows ONLY its own delta and it merges cleanly in
//              order. Best when a later PR logically sits on top of an earlier one.
//
//   sequence → N independent PRs off the base, conflict resolved at MERGE time. No code
//              changes now: just record a blocked-by ordering and comment it on each PR. When
//              a blocker merges, the CI poller auto-runs the existing rebase (merge base +
//              regenerate lockfile) on the next PR. Lightest touch; each PR reviews fully
//              independently. (The auto-rebase trigger lives in server.js's pollSequenceLinks.)

const { run, stream } = require("./exec");
const { jobContext, isJunkPath } = require("./job");
const { runClaude } = require("./fixer");
const state = require("./state");
const fsSync = require("fs");
const path = require("path");

const exists = (p) => fsSync.existsSync(p);

// Effort/model/timeout for the stack session — conflict-heavy like a rollup, so MAX by
// default. Reads config.claudeStack, falling back to config.claudeRollup then sane defaults.
function sessionOpts(cfgBlock) {
  const c = cfgBlock || {};
  return {
    mode: c.permissionMode || "auto",
    effort: c.effort || "max",
    model: c.model || undefined,
    timeoutMin: c.timeoutMinutes || 45,
  };
}

// Valid PRs IN THE ORDER GIVEN — the caller (server) has already put them in the intended
// merge order (the user's drag-chosen order, or the FIFO default from computeConsolidationCluster).
// First = bottom of the stack / front of the sequence. We only drop entries missing a number
// or branch; we do NOT re-sort, so a deliberate reorder is respected.
function ordered(prs) {
  return (prs || []).filter((p) => p && p.number && p.headRefName);
}

async function ensureClone({ nwo, dir, workRoot, log, onLn }) {
  // A REUSED clone (another job made it) can be stale/SHALLOW, so fetching a force-moved
  // branch into it fails — refresh all refs (and unshallow) before any per-PR fetch.
  if (exists(path.join(dir, ".git"))) {
    const shallow = (await run("git", ["-C", dir, "rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
    log(`$ git fetch origin --prune${shallow ? " --unshallow" : ""}  (refresh reused clone)`);
    const fc = await run("git", ["-C", dir, "fetch", "origin", "--prune", ...(shallow ? ["--unshallow"] : [])]);
    if (fc.code !== 0) await run("git", ["-C", dir, "fetch", "origin", "--prune"]).catch(() => {});
    return;
  }
  if (exists(dir)) await require("fs/promises").rm(dir, { recursive: true, force: true });
  log(`$ gh repo clone ${nwo}`);
  await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
}

function stackPrompt(nwo, base, lock, chain) {
  // chain: [{ number, branch }, …] bottom → top. chain[0] stays on `base`; each later
  // branch must be merged on top of the one before it.
  const steps = chain.slice(1).map((c, i) => {
    const parent = chain[i]; // the branch below this one
    return [
      `### PR #${c.number} — branch \`${c.branch}\` onto \`${parent.branch}\``,
      `\`git checkout ${c.branch}\` then \`git merge --no-edit ${parent.branch}\`.`,
      `Resolve any conflict by KEEPING BOTH upgrades (never drop \`${parent.branch}\`'s bump to satisfy this one), then regenerate the lockfile and commit the merge.`,
    ].join("\n");
  });
  return [
    `This is \`${nwo}\` — STACKING ${chain.length} dependency PRs that all branched off \`${base}\` and collide on \`${lock}\`. The repo is cloned here and every PR branch is checked out locally (same name as on origin).`,
    ``,
    `The stack, bottom → top: ${chain.map((c) => `#${c.number} (\`${c.branch}\`)`).join(" → ")}.`,
    `\`${chain[0].branch}\` is the bottom and stays as-is. Each branch above must end up CONTAINING the branch below it (so once its PR base is retargeted to that branch, its diff shows only its own change and it merges cleanly in order).`,
    ``,
    `## Do these in order`,
    steps.join("\n\n"),
    ``,
    `## Regenerate the lockfile after each merge`,
    `Both PRs bump dependencies, so \`${lock}\` is an incoherent blend after a merge even when git reported no textual conflict. Regenerate it from the manifests via the repo's pinned toolchain through mise:`,
    `- npm: \`mise exec -- npm install\` (or \`yarn install\` / \`pnpm install\` to match the repo's lockfile)`,
    `- ruby: \`mise exec -- bundle install\``,
    `Run \`mise install\` first if the pinned runtime isn't present. Confirm both upgrades resolve at/above their intended version in the lockfile.`,
    ``,
    `## Finish`,
    `Leave each branch checked-out-and-committed locally; commit any merge with a concise message. \`git add\` ONLY dependency manifests + lockfiles (never tracker/state files: \`.beads/\`, \`.DS_Store\`). Do NOT push and do NOT open or edit any PR — the dashboard pushes the branches and retargets the PR bases.`,
  ].filter((l) => l !== undefined).join("\n");
}

/**
 * STACK: order the PRs, merge each onto the one below + regenerate the lockfile (one
 * headless session), push the rewritten branches, then retarget each PR's base to the
 * branch below it. Result: the same N PRs, now non-conflicting and mergeable in order.
 * @param {{config, repo, prs, base, lock, emit}} a
 */
async function createStackPRs({ config, repo, prs, base, lock, emit }) {
  const ctx = await jobContext({ config, repo, emit });
  const { nwo, dir, log, step, sh } = ctx;
  const baseBranch = base || repo.defaultBranch || "main";
  const chain = ordered(prs);
  if (chain.length < 2) {
    log("Need at least two PRs sharing a base + lockfile to stack — nothing to do.", "warn");
    emit("done", { changed: false });
    return { changed: false };
  }

  step("Cloning");
  await ensureClone(ctx);

  step("Fetching base + PR branches");
  await run("git", ["-C", dir, "fetch", "origin", baseBranch]).catch(() => {});
  for (const c of chain) {
    const f = await run("git", ["-C", dir, "fetch", "origin", `+${c.headRefName}:${c.headRefName}`]);
    if (f.code !== 0) {
      log(`Couldn't fetch PR #${c.number} (${c.headRefName}) — aborting stack.`, "warn");
      emit("done", { changed: false });
      return { changed: false };
    }
  }

  step("Stacking branches (headless session)");
  const session = sessionOpts(config.claudeStack || config.claudeRollup);
  const chainRefs = chain.map((c) => ({ number: c.number, branch: c.headRefName }));
  log(`$ claude -p --permission-mode ${session.mode} --effort ${session.effort}${session.model ? ` --model ${session.model}` : ""}`, "warn");
  const sessionCode = await runClaude({ prompt: stackPrompt(nwo, baseBranch, lock || "the lockfile", chainRefs), cwd: dir, log, ...session });

  // Drop any tracker/state junk the session may have staged on any branch.
  await run("git", ["-C", dir, "add", "-A"]);
  const junk = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junk.length) {
    log(`Excluding tracker/state file(s): ${junk.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junk]);
  }

  // GUARD: don't force-push the branches or retarget PR bases unless the session actually
  // built the stack — i.e. each child branch now CONTAINS the branch below it. A failed/
  // auth-broken session would otherwise leave the branches un-stacked, and retargeting a
  // PR's base to a branch it doesn't contain produces a broken/confusing PR. Abort cleanly;
  // nothing was pushed or retargeted, so the PRs are untouched and a retry is safe.
  const broken = [];
  for (let i = 1; i < chain.length; i++) {
    const anc = await run("git", ["-C", dir, "merge-base", "--is-ancestor", chain[i - 1].headRefName, chain[i].headRefName]);
    if (anc.code !== 0) broken.push(chain[i]);
  }
  if (sessionCode !== 0 || broken.length) {
    const why = broken.length
      ? `${broken.map((c) => "#" + c.number).join(", ")} do not contain the branch below them (the stack wasn't built)`
      : `the session exited ${sessionCode}`;
    log(`✗ Stack aborted — ${why}. Nothing pushed or retargeted; the PRs are unchanged. If this was an auth error ("401"), re-authenticate the \`claude\` CLI and restart the server, then re-run.`, "warn");
    emit("done", { changed: false, failed: true });
    return { changed: false, failed: true };
  }

  step("Pushing stacked branches");
  // Push every branch above the bottom (those are the ones the session rewrote). Bottom
  // branch is untouched, so skip it.
  for (const c of chain.slice(1)) {
    log(`$ git push --force-with-lease origin ${c.headRefName}`);
    const pc = await sh("git", ["push", "--force-with-lease", "origin", c.headRefName]);
    if (pc !== 0) await sh("git", ["push", "origin", c.headRefName]);
  }

  step("Retargeting PR bases + linking");
  const links = [];
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i];
    const parent = chain[i - 1];
    const e = await run("gh", ["pr", "edit", String(child.number), "--repo", nwo, "--base", parent.headRefName]);
    if (e.code === 0) {
      state.setPrLink(repo.name, child.number, parent.number, "stack");
      links.push({ number: child.number, blockedBy: parent.number });
      log(`✓ PR #${child.number} now targets \`${parent.headRefName}\` (stacked on #${parent.number})`);
      await run("gh", ["pr", "comment", String(child.number), "--repo", nwo, "--body",
        `🥞 Stacked on #${parent.number} — its changes are merged in here, so this PR now shows only its own delta. Merge #${parent.number} first; GitHub will retarget this to \`${baseBranch}\` automatically once it lands.`]);
    } else {
      log(`⚠ couldn't retarget PR #${child.number}'s base: ${(e.stderr || "").trim()}`, "warn");
    }
  }

  log(`\nStacked ${chain.length} PRs on ${nwo}: ${chain.map((c) => `#${c.number}`).join(" → ")}. Merge bottom-up.`);
  emit("done", { changed: true, stacked: chain.length, order: chain.map((c) => c.number), links });
  return { changed: true, stacked: chain.length, order: chain.map((c) => c.number), links };
}

/**
 * SEQUENCE: keep every PR independent off the base, but record a blocked-by ordering and
 * comment it on each PR. No git work now — the CI poller (pollSequenceLinks) auto-rebases
 * each PR once its blocker merges. Result: the same N PRs, reviewed independently, merged
 * in order with the conflict resolved lazily at merge time.
 * @param {{config, repo, prs, base, lock, emit}} a
 */
async function createSequencePlan({ config, repo, prs, base, lock, emit }) {
  const nwo = `${config.org}/${repo.name}`;
  const baseBranch = base || repo.defaultBranch || "main";
  const chain = ordered(prs);
  const log = (line, level = "info") => emit("log", { line, level });
  const step = (name) => emit("step", { name });
  if (chain.length < 2) {
    log("Need at least two PRs sharing a base + lockfile to sequence — nothing to do.", "warn");
    emit("done", { changed: false });
    return { changed: false };
  }

  step("Recording sequence + commenting");
  const links = [];
  for (let i = 1; i < chain.length; i++) {
    const cur = chain[i];
    const blocker = chain[i - 1];
    state.setPrLink(repo.name, cur.number, blocker.number, "sequence");
    links.push({ number: cur.number, blockedBy: blocker.number });
    const c = await run("gh", ["pr", "comment", String(cur.number), "--repo", nwo, "--body",
      `⏱ Sequenced after #${blocker.number} (they both change \`${lock || "the lockfile"}\` and would conflict). Review this independently — once #${blocker.number} merges, the dashboard auto-rebases this branch onto \`${baseBranch}\` and regenerates the lockfile, then it's ready.`]);
    if (c.code === 0) log(`✓ #${cur.number} sequenced after #${blocker.number}`);
    else log(`⚠ recorded #${cur.number} after #${blocker.number}, but couldn't comment: ${(c.stderr || "").trim()}`, "warn");
  }
  // A note on the front PR so the ordering is visible from either end.
  await run("gh", ["pr", "comment", String(chain[0].number), "--repo", nwo, "--body",
    `⏱ First in a sequence of ${chain.length} dependency PRs that touch \`${lock || "the same lockfile"}\` — merge this one first; the rest auto-rebase in order behind it.`]).catch(() => {});

  log(`\nSequenced ${chain.length} PRs on ${nwo}: ${chain.map((c) => `#${c.number}`).join(" → ")}. Each auto-rebases when its blocker merges.`);
  emit("done", { changed: true, sequenced: chain.length, order: chain.map((c) => c.number), links });
  return { changed: true, sequenced: chain.length, order: chain.map((c) => c.number), links };
}

module.exports = { createStackPRs, createSequencePlan, stackPrompt, ordered };
