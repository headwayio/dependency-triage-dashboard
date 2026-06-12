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

module.exports = { jobContext };
