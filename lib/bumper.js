"use strict";

// Drive a headless Claude Code session to raise a GEM's gemspec/Gemfile version
// constraints that cap a dependency below its security-patched version, make the
// (possibly breaking) upgrade build, then open a draft PR. This is the actionable
// remediation for a "blocked" gem disposition — unlike a covered gem (no action)
// or an app (a lockfile bump). Streams progress via emit(), mirroring createUpdatePR.

const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { run, stream, todayStamp } = require("./exec");
const { jobContext, isJunkPath } = require("./job");
const { runClaude } = require("./fixer");

const exists = (p) => fsSync.existsSync(p);

function buildBumpPrompt(nwo, branch, blocked) {
  const lines = (blocked || []).map((b) => `- ${b}`).join("\n");
  return [
    `This is the Ruby gem \`${nwo}\` (branch \`${branch}\`, already checked out in this directory). Its **gemspec/Gemfile version constraints CAP one or more dependencies below their security-patched versions**, which holds every app that depends on this gem on a vulnerable release. Your job: raise the blocking constraints to admit the patched versions and make the gem build with the SMALLEST reasonable change.`,
    ``,
    `## Constraints that block a patch`,
    lines || "(inspect the .gemspec — a runtime dependency is pinned below its patched version)",
    ``,
    `## How to fix`,
    `- Edit the \`*.gemspec\` (and \`Gemfile\` if it re-declares the same gems) to raise each blocking \`add_dependency\` / \`add_runtime_dependency\` / \`gem\` constraint so the patched version is admissible — e.g. widen \`"~> 1.0"\` to \`">= 1.0", "< 3"\` or bump the floor to \`">= 2.2.7"\`. Prefer the least-wide change that admits the patch.`,
    `- Admitting the patch may pull in a MAJOR version with breaking API changes. Update this gem's own code and tests to match. Keep the diff minimal and focused on the upgrade — do not refactor unrelated code.`,
    `- Use the repo's pinned toolchain through mise: \`mise exec -- bundle install\`, then \`mise exec -- bundle exec rake\` (or \`rspec\`). If the pinned Ruby isn't installed yet, run \`mise install\` first.`,
    `- Get the test suite green where feasible. If a failure is clearly pre-existing and unrelated to this bump, leave it and say so.`,
    ``,
    `## Finish`,
    `When done, \`git add\` the files YOUR fix changed and commit with a concise message like \`chore(deps): raise gemspec constraints for security patches\`. Never stage tool/tracker state files other tooling may have rewritten mid-session (e.g. \`.beads/\`, editor configs, \`.DS_Store\`). Do NOT push or open a pull request — the dashboard does that. Do not bump this gem's own version number unless a test requires it.`,
  ].join("\n");
}

/**
 * @param {{config, repo, blocked:string[], emit:(t,d)=>void}} a
 */
async function createConstraintBumpPR({ config, repo, blocked, emit }) {
  const { nwo, dir, workRoot, log, step, onLn, sh } = await jobContext({ config, repo, emit });
  const base = repo.defaultBranch || "main";
  const branch = `gemspec-bump/soc2-${todayStamp()}`;

  // ---- 1. Fresh clone (full, so we can push + open a PR) + branch ----------
  step("Cloning");
  if (!exists(path.join(dir, ".git"))) {
    if (exists(dir)) await fs.rm(dir, { recursive: true, force: true });
    log(`$ gh repo clone ${nwo}`);
    await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
  } else {
    await run("git", ["-C", dir, "fetch", "origin", base]).catch(() => {});
    await run("git", ["-C", dir, "checkout", base]).catch(() => {});
    await run("git", ["-C", dir, "reset", "--hard", `origin/${base}`]).catch(() => {});
  }
  step("Branching");
  log(`$ git switch -C ${branch}`);
  await sh("git", ["switch", "-C", branch]);
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  // ---- 2. Headless Claude constraint-bump session -------------------------
  step("Claude constraint-bump session");
  const mode = (config.claudeBump && config.claudeBump.permissionMode) || (config.claudeFix && config.claudeFix.permissionMode) || "auto";
  const timeoutMin = (config.claudeBump && config.claudeBump.timeoutMinutes) || 20;
  log(`$ claude -p --permission-mode ${mode}   (raising ${(blocked || []).length} blocking constraint(s))`, "warn");
  await runClaude({ prompt: buildBumpPrompt(nwo, branch, blocked), mode, cwd: dir, log, timeoutMin });

  // ---- 3. Commit whatever it changed --------------------------------------
  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
  // A constraint bump can legitimately touch code/tests, so no allowlist here —
  // but tracker/state files repo tooling rewrote mid-session never belong.
  const junkStaged = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junkStaged.length) {
    log(`Excluding tracker/state file(s) from the commit: ${junkStaged.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junkStaged]);
  }
  const after0 = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  let committed = after0 !== before; // Claude may have committed itself
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (!committed && staged.code !== 0) {
    await run("git", ["-C", dir, "commit", "-m", "chore(deps): raise gemspec constraints for security patches"]);
    committed = true;
  }
  if (!committed) {
    log("Claude produced no constraint change — this one needs a manual look.", "warn");
    emit("done", { prUrl: null, changed: false, branch });
    return { prUrl: null, changed: false };
  }
  // Surface exactly what the PR will contain; flag tracker/state files in case
  // Claude committed them itself (the prompt forbids it, but belt and braces).
  const touched = (await run("git", ["-C", dir, "diff", "--name-only", `${before}..HEAD`])).stdout.split("\n").filter(Boolean);
  log(`PR will contain ${touched.length} file(s): ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? ", …" : ""}`);
  const junkCommitted = touched.filter(isJunkPath);
  if (junkCommitted.length) log(`⚠ Commit includes tracker/state file(s): ${junkCommitted.join(", ")} — review the PR diff before merging.`, "warn");

  // ---- 4. Push + open a draft PR ------------------------------------------
  step("Pushing branch");
  log(`$ git push --force-with-lease -u origin ${branch}`);
  const pc = await sh("git", ["push", "--force-with-lease", "-u", "origin", branch]);
  if (pc !== 0) await sh("git", ["push", "-u", "origin", branch]);

  step("Opening pull request");
  const body = [
    `## Raise gemspec constraints for security patches`,
    ``,
    `This gem's version constraints capped one or more dependencies **below their security-patched versions**, holding every consuming app on vulnerable releases. This PR raises the blocking constraints so the patched versions are admissible, with code/test changes for any breaking upgrade.`,
    ``,
    `### Constraints that were blocking a patch`,
    ...(blocked || []).map((b) => `- ${b}`),
    ``,
    `> ⚠️ Generated by the Dependency Dashboard via an automated Claude session. A constraint bump can be a breaking major upgrade — **review the diff and CI carefully**, and bump this gem's version + cut a release as appropriate.`,
  ].join("\n");
  const bodyFile = path.join(os.tmpdir(), `hw-bump-${repo.name}-${todayStamp()}.md`);
  await fs.writeFile(bodyFile, body, "utf8");
  const title = `chore(deps): raise gemspec constraints for security patches — ${todayStamp()}`;
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

  emit("done", { prUrl, changed: true, branch, title });
  return { prUrl, changed: true, title };
}

module.exports = { createConstraintBumpPR, buildBumpPrompt };
