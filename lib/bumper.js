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
const { run, stream } = require("./exec");
const { assertRepoName } = require("./github");
const { runClaude } = require("./fixer");

const exists = (p) => fsSync.existsSync(p);

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
    `When done, \`git add -A\` and commit with a concise message like \`chore(deps): raise gemspec constraints for security patches\`. Do NOT push or open a pull request — the dashboard does that. Do not bump this gem's own version number unless a test requires it.`,
  ].join("\n");
}

/**
 * @param {{config, repo, blocked:string[], emit:(t,d)=>void}} a
 */
async function createConstraintBumpPR({ config, repo, blocked, emit }) {
  assertRepoName(repo.name);
  const org = config.org;
  const nwo = `${org}/${repo.name}`;
  const base = repo.defaultBranch || "main";
  const log = (line, level = "info") => emit("log", { line, level });
  const step = (name) => emit("step", { name });

  const root = path.resolve(__dirname, "..");
  const workRoot = path.resolve(root, config.workDir || ".work");
  const dir = path.join(workRoot, repo.name);
  await fs.mkdir(workRoot, { recursive: true });
  const onLn = (line, which) => log(line, which === "stderr" ? "warn" : "info");
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
  await stream("git", ["switch", "-C", branch], { cwd: dir }, onLn);
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  // ---- 2. Headless Claude constraint-bump session -------------------------
  step("Claude constraint-bump session");
  const mode = (config.claudeBump && config.claudeBump.permissionMode) || (config.claudeFix && config.claudeFix.permissionMode) || "auto";
  const timeoutMin = (config.claudeBump && config.claudeBump.timeoutMinutes) || 20;
  log(`$ claude -p --permission-mode ${mode}   (raising ${(blocked || []).length} blocking constraint(s))`, "warn");
  const code = await runClaude(
    ["-p", buildBumpPrompt(nwo, branch, blocked), "--permission-mode", mode, "--output-format", "stream-json", "--verbose"],
    dir,
    log,
    timeoutMin * 60000
  );
  if (code !== 0) log(`Claude exited ${code === 124 ? "(timed out)" : `with code ${code}`}.`, "warn");

  // ---- 3. Commit whatever it changed --------------------------------------
  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
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

  // ---- 4. Push + open a draft PR ------------------------------------------
  step("Pushing branch");
  log(`$ git push --force-with-lease -u origin ${branch}`);
  const pc = await stream("git", ["push", "--force-with-lease", "-u", "origin", branch], { cwd: dir }, onLn);
  if (pc !== 0) await stream("git", ["push", "-u", "origin", branch], { cwd: dir }, onLn);

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
  const prArgs = [
    "pr", "create",
    "--repo", nwo,
    "--base", base,
    "--head", branch,
    "--title", `chore(deps): raise gemspec constraints for security patches — ${todayStamp()}`,
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

  emit("done", { prUrl, changed: true, branch });
  return { prUrl, changed: true };
}

module.exports = { createConstraintBumpPR, buildBumpPrompt };
