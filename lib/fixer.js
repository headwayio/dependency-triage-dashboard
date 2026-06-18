"use strict";

// Drive a headless Claude Code session to fix a PR's failing CI checks, then
// commit & push to the PR branch. Streams progress via emit(type, data), mirroring
// createUpdatePR's contract: 'log' (line, level), 'step' (name), 'done', 'error'.

const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { run, stream } = require("./exec");
const { jobContext, isJunkPath } = require("./job");

const exists = (p) => fsSync.existsSync(p);

function buildFixPrompt(nwo, branch, failingLogs) {
  const blocks = failingLogs
    .map((f) => `### ${f.name}\n\`\`\`\n${f.log}\n\`\`\``)
    .join("\n\n");
  return [
    `A draft pull request on \`${nwo}\` (branch \`${branch}\`, already checked out in this directory) made automated, **lockfile-only** dependency updates, and CI is now failing. Make the failing checks pass with the SMALLEST reasonable change.`,
    ``,
    `## Failing checks and their errors`,
    ``,
    blocks,
    ``,
    `## Guidance`,
    `- Prefer fixes tied to the dependency bump: adjust \`go.mod\`/\`go.sum\` (e.g. the \`go\`/\`toolchain\` directive), run formatters (\`go fmt ./...\`, \`bundle exec rubocop -A\`, \`prettier -w\`), regenerate a lockfile, or pin/adjust a transitive dependency.`,
    `- Run tools through mise so the repo's pinned toolchain is used: \`mise exec -- <cmd>\` (or \`mise exec <tool>@<version> -- <cmd>\`).`,
    `- Some failures may be PRE-EXISTING (unrelated to the bump). Fix them only if trivial (e.g. formatting) and say so.`,
    `- Keep the diff minimal and focused. Do NOT refactor or change application logic.`,
    `- Verify locally where cheap (re-run the formatter/build), but you don't need the full suite green locally — CI is the gate.`,
    ``,
    `## Finish`,
    `When the fixes are in place, \`git add\` ONLY the files your fix changed — never tool/tracker state files other tooling may have rewritten mid-session (e.g. \`.beads/\`, editor configs, \`.DS_Store\`) — commit with a concise message like \`fix(ci): resolve failing checks after dependency update\`, and \`git push\` to the current branch (\`${branch}\`). It's a draft PR; CI re-runs on push. Do not open a new PR or change the base branch.`,
  ].join("\n");
}

function toolBrief(b) {
  const i = b.input || {};
  if (b.name === "Bash") return `: ${String(i.command || "").replace(/\s+/g, " ").slice(0, 140)}`;
  if (b.name === "Edit" || b.name === "Write" || b.name === "Read") return `: ${i.file_path || i.path || ""}`;
  if (b.name === "Grep" || b.name === "Glob") return `: ${i.pattern || ""}`;
  return "";
}

// Turn one stream-json event into a readable log line (or null to skip).
function summarizeEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "system" && evt.subtype === "init") return `Claude session started (model ${evt.model || "default"}).`;
  if (evt.type === "assistant" && evt.message) {
    const parts = [];
    for (const b of evt.message.content || []) {
      if (b.type === "text" && b.text && b.text.trim()) parts.push(b.text.trim());
      else if (b.type === "tool_use") parts.push(`▸ ${b.name}${toolBrief(b)}`);
    }
    return parts.join("\n") || null;
  }
  if (evt.type === "result") {
    const cost = typeof evt.total_cost_usd === "number" ? ` · $${evt.total_cost_usd.toFixed(2)}` : "";
    const turns = evt.num_turns != null ? `${evt.num_turns} turns` : "done";
    return `${evt.is_error ? "✗" : "✓"} Claude session ${evt.subtype || "ended"} — ${turns}${cost}.`;
  }
  return null;
}

// Spawn `claude` headless with the standard args, parse its stream-json NDJSON, and
// emit readable lines. Logs a non-zero exit; resolves with the exit code (124 = timed
// out). Kills the session after timeoutMin minutes.
function runClaude({ prompt, mode, cwd, log, timeoutMin, effort, model }) {
  const timeoutMs = timeoutMin * 60000;
  const args = ["-p", prompt, "--permission-mode", mode, "--output-format", "stream-json", "--verbose"];
  // Deeper, breaking work (major upgrades / unblocking constraint-capped deps) runs at a
  // higher reasoning effort and optionally a specific model. Omitted → CLI/session default.
  if (effort) args.push("--effort", effort);
  if (model) args.push("--model", model);
  return new Promise((resolve) => {
    const finish = (code) => {
      if (code !== 0) log(`Claude exited ${code === 124 ? "(timed out)" : `with code ${code}`}.`, "warn");
      resolve(code);
    };
    const child = spawn("claude", args, { cwd, shell: false, env: process.env });
    let buf = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      log(`Claude session exceeded ${Math.round(timeoutMs / 60000)} min — terminating.`, "warn");
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);

    const pump = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const summary = summarizeEvent(JSON.parse(line));
          if (summary) for (const l of summary.split("\n")) log(l);
        } catch {
          log(line); // non-JSON line — surface verbatim
        }
      }
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", (d) => log(d.toString().trimEnd(), "warn"));
    child.on("error", (e) => { clearTimeout(timer); log("claude failed to start: " + e.message, "warn"); finish(-1); });
    child.on("close", (code) => { clearTimeout(timer); finish(killed ? 124 : code ?? -1); });
  });
}

/**
 * @param {{config, repo, pr:{number,url}, branch:string, prStatus, failingLogs, emit}} a
 */
async function createFixSession({ config, repo, pr, branch, prStatus, failingLogs, emit }) {
  const { nwo, dir, workRoot, log, step, onLn, sh } = await jobContext({ config, repo, emit });

  // ---- 1. Check out the PR branch (full clone so we can push) -------------
  step("Preparing checkout");
  if (!exists(path.join(dir, ".git"))) {
    if (exists(dir)) await fs.rm(dir, { recursive: true, force: true });
    log(`$ gh repo clone ${nwo} ${dir}`);
    await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
  }
  log(`$ gh pr checkout ${pr.number}`);
  const co = await sh("gh", ["pr", "checkout", String(pr.number), "--repo", nwo, "--force"]);
  if (co !== 0) {
    emit("error", { message: "Couldn't check out the PR branch — aborting the fix session." });
    return { ok: false };
  }
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  // ---- 2. Headless Claude session ----------------------------------------
  step("Claude fix session");
  const mode = (config.claudeFix && config.claudeFix.permissionMode) || "auto";
  const timeoutMin = (config.claudeFix && config.claudeFix.timeoutMinutes) || 12;
  log(`$ claude -p --permission-mode ${mode}   (fixing ${prStatus.failing.length} failing check(s))`, "warn");
  await runClaude({ prompt: buildFixPrompt(nwo, branch, failingLogs), mode, cwd: dir, log, timeoutMin });

  // ---- 3. Did it commit / push? ------------------------------------------
  step("Verifying");
  const after = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  const committed = after !== before;
  let pushed = false;
  if (committed) {
    // Surface what the fix added to the PR; flag tracker/state files that repo
    // tooling rewrites on its own (the prompt forbids staging them).
    const touched = (await run("git", ["-C", dir, "diff", "--name-only", `${before}..${after}`])).stdout.split("\n").filter(Boolean);
    log(`Fix touched ${touched.length} file(s): ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? ", …" : ""}`);
    const junk = touched.filter(isJunkPath);
    if (junk.length) log(`⚠ Fix commit includes tracker/state file(s): ${junk.join(", ")} — review the PR diff before merging.`, "warn");
  }
  if (committed) {
    await run("git", ["-C", dir, "fetch", "origin", branch]).catch(() => {});
    const remote = (await run("git", ["-C", dir, "rev-parse", `origin/${branch}`])).stdout.trim();
    pushed = remote === after;
    if (!pushed) {
      log("Claude committed but the push didn't land — pushing now.", "warn");
      const pc = await sh("git", ["push", "origin", `HEAD:${branch}`]);
      if (pc === 0) pushed = true;
    }
  }

  if (committed && pushed) {
    log(`✓ Pushed a fix to ${branch} — CI will re-run.`, "info");
  } else if (committed) {
    log("Committed a fix locally but couldn't push it.", "warn");
  } else {
    log("Claude made no commit — the failures may need a manual look.", "warn");
  }

  emit("done", { committed, pushed, sha: after, prUrl: pr.url });
  return { committed, pushed, sha: after };
}

module.exports = { createFixSession, buildFixPrompt, runClaude, summarizeEvent };
