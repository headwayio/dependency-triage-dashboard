"use strict";

// Shared per-job setup for the update / fix / bump flows: the emit helpers, the
// .work checkout location, and a stream wrapper scoped to the repo checkout.

const fs = require("fs/promises");
const path = require("path");
const { stream } = require("./exec");
const { assertRepoName } = require("./github");

/**
 * Common preamble for a background job on one repo. Returns
 * { nwo, dir, workRoot, log, step, onLn, sh }.
 *
 * NOTE: sh() defaults cwd to the repo checkout (`dir`), which does not exist
 * until your clone step — run clones via stream(cmd, args, { cwd: workRoot }, onLn).
 */
async function jobContext({ config, repo, emit }) {
  assertRepoName(repo.name);
  const nwo = `${config.org}/${repo.name}`;
  const workRoot = path.resolve(__dirname, "..", config.workDir || ".work");
  const dir = path.join(workRoot, repo.name);
  await fs.mkdir(workRoot, { recursive: true });
  const log = (line, level = "info") => emit("log", { line, level });
  const step = (name) => emit("step", { name });
  const onLn = (line, which) => log(line, which === "stderr" ? "warn" : "info");
  const sh = (cmd, args, opts = {}) => stream(cmd, args, { cwd: dir, ...opts }, onLn);
  return { nwo, dir, workRoot, log, step, onLn, sh };
}

// Tracker/state files that repo tooling rewrites on its own mid-job (issue
// trackers like beads, OS droppings) — never something a dependency job should
// commit. Extend as new offenders show up. Seen in the wild: a bd (beads) hook
// rewrote .beads/issues.jsonl during an update job and `git add -A` shipped a
// 78-line diff of issue-tracker state into the dependency PR.
const JUNK_PATH_RE = /(^|\/)(\.beads\/|\.beads$|\.DS_Store$)/;
const isJunkPath = (f) => JUNK_PATH_RE.test(f);

module.exports = { jobContext, isJunkPath };
