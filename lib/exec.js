"use strict";

const { spawn } = require("child_process");

/**
 * Run a command to completion, buffering output.
 * Always passes args as an array with shell:false — no string interpolation,
 * so there is no shell-injection surface even though inputs come from GitHub.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject); // ENOENT etc.
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Like run(), but rejects on a non-zero exit code. */
async function runOrThrow(cmd, args = [], opts = {}) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    const err = new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${res.code}\n${res.stderr || res.stdout}`.trim()
    );
    err.result = res;
    throw err;
  }
  return res;
}

/**
 * Spawn a command and stream its combined stdout/stderr line-by-line to onLine.
 * Resolves with the exit code. Never rejects on non-zero exit — the caller
 * decides what a given exit code means (e.g. `git diff --quiet` uses code 1).
 *
 * @param {(line:string, stream:'stdout'|'stderr')=>void} onLine
 * @returns {Promise<number>}
 */
function stream(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, ...opts });
    const buffers = { stdout: "", stderr: "" };

    const pump = (chunk, which) => {
      buffers[which] += chunk.toString();
      let idx;
      while ((idx = buffers[which].indexOf("\n")) !== -1) {
        const line = buffers[which].slice(0, idx);
        buffers[which] = buffers[which].slice(idx + 1);
        onLine(line, which);
      }
    };

    child.stdout.on("data", (d) => pump(d, "stdout"));
    child.stderr.on("data", (d) => pump(d, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      // flush any trailing partial lines
      for (const which of ["stdout", "stderr"]) {
        if (buffers[which]) onLine(buffers[which], which);
      }
      resolve(code ?? -1);
    });
  });
}

module.exports = { run, runOrThrow, stream };
