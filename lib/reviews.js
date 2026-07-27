"use strict";

// Read a PR's review feedback (Copilot + human review threads), optionally triage the
// Copilot ones with a quick advisory verdict, then drive a headless Claude session that
// ADDRESSES the selected threads, pushes the branch, and replies-to + resolves each.
//
// Mirrors lib/fixer.js's checkout→session→push contract. The "investigate" pass is a cheap
// one-shot Claude call (no clone) that returns proceed/skip suggestions for Copilot comments;
// the actual fix is always a deliberate, user-triggered batch over the threads left selected.

const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { run, stream } = require("./exec");
const { jobContext, isJunkPath } = require("./job");
const { runClaude } = require("./fixer");

const exists = (p) => fsSync.existsSync(p);

// A login is Copilot's reviewer bot — its review comments are the auto-triage target.
const isCopilotLogin = (login) => /copilot/i.test(String(login || ""));

/**
 * Unresolved (and not-outdated) review threads on a PR, each reduced to its primary
 * comment. Returns [{ id, isResolved, isOutdated, author, isCopilot, body, path, line,
 * diffHunk, url }]. `id` is the reviewThread node id (used to reply + resolve).
 */
async function fetchReviewThreads(nwo, number) {
  const slash = String(nwo).indexOf("/");
  const owner = String(nwo).slice(0, slash);
  const name = String(nwo).slice(slash + 1);
  const query =
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){` +
    `pullRequest(number:$number){reviewThreads(first:100){nodes{` +
    `id isResolved isOutdated comments(first:1){nodes{` +
    `author{login __typename} body path line originalLine diffHunk url}}}}}}}`;
  const res = await run("gh", [
    "api", "graphql",
    "-f", `query=${query}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${Number(number)}`,
  ]);
  if (res.code !== 0) throw new Error((res.stderr || "gh api graphql failed").trim());
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch { return []; }
  const nodes = (((parsed.data || {}).repository || {}).pullRequest || {}).reviewThreads;
  const threads = ((nodes && nodes.nodes) || []).map((t) => {
    const c = ((t.comments || {}).nodes || [])[0] || {};
    const login = (c.author && c.author.login) || "";
    return {
      id: t.id,
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      author: login,
      isCopilot: isCopilotLogin(login),
      body: c.body || "",
      path: c.path || "",
      line: c.line || c.originalLine || null,
      diffHunk: c.diffHunk || "",
      url: c.url || "",
    };
  });
  return threads;
}

// Count of actionable (unresolved, not-outdated) threads — cheap signal for the PR row.
async function countOpenReviewThreads(nwo, number) {
  const threads = await fetchReviewThreads(nwo, number).catch(() => []);
  return threads.filter((t) => !t.isResolved && !t.isOutdated).length;
}

// One-shot headless Claude returning its final text (no streaming, no clone). Used for the
// quick triage pass. Kills the process after timeoutMin. Resolves "" on any failure.
function runClaudeOneShot({ prompt, timeoutMin = 4, effort = "low" }) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (effort) args.push("--effort", effort);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const child = spawn("claude", args, { shell: false, env: process.env });
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} finish(""); }, timeoutMin * 60000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => finish(""));
    child.on("close", () => {
      // `--output-format json` wraps the reply in an envelope; the text is in `.result`.
      try { finish(JSON.parse(out).result || ""); } catch { finish(out); }
    });
  });
}

// First top-level JSON array in a string (the model may wrap it in prose/fences).
function extractJsonArray(text) {
  const s = String(text || "");
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * Advisory triage of Copilot threads: for each, "fix" (worth addressing) or "skip" (likely
 * a false-positive / nit / out of scope), with a one-line reason. Returns a map
 * { [threadId]: { recommend:"fix"|"skip", reason } }. Best-effort — empty map on failure.
 */
async function investigateThreads(nwo, threads) {
  const list = (threads || []).filter((t) => t.isCopilot && !t.isResolved);
  if (!list.length) return {};
  const blocks = list
    .map((t, i) => `### ${i + 1}. id=${t.id}\nFile: ${t.path}:${t.line || "?"}\nComment: ${t.body}\n${t.diffHunk ? `Diff:\n${t.diffHunk}` : ""}`)
    .join("\n\n");
  const prompt = [
    `You are triaging GitHub Copilot automated code-review comments on a dependency-update PR for \`${nwo}\`. Copilot is helpful but noisy — it often raises stylistic nits, false positives, or out-of-scope suggestions on a focused dependency bump.`,
    ``,
    `For EACH comment below, decide:`,
    `- "fix" — a real, in-scope issue worth a code change, OR`,
    `- "skip" — a likely false positive, pure nit, or out of scope for a dependency update.`,
    `Give a one-line reason (≤140 chars).`,
    ``,
    `## Comments`,
    blocks,
    ``,
    `## Output`,
    `Output ONLY a JSON array, no prose, no code fences. Each element: {"id":"<the id shown>","recommend":"fix"|"skip","reason":"..."}. Include every comment exactly once, using its given id.`,
  ].join("\n");
  const text = await runClaudeOneShot({ prompt, timeoutMin: 4, effort: "low" });
  const arr = extractJsonArray(text);
  const map = {};
  if (Array.isArray(arr)) {
    for (const v of arr) {
      if (v && v.id) map[v.id] = { recommend: v.recommend === "skip" ? "skip" : "fix", reason: String(v.reason || "").slice(0, 200) };
    }
  }
  return map;
}

// Reply to a review thread, then resolve it (two GraphQL mutations). Best-effort per call.
async function replyAndResolveThread(threadId, body) {
  // Use -f (plain string) for the variable values, NOT -F (which does @file expansion +
  // type coercion) — a reply body could otherwise be misread as a filename or number.
  const reply = await run("gh", [
    "api", "graphql",
    "-f", `query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}`,
    "-f", `t=${threadId}`,
    "-f", `b=${body}`,
  ]);
  const resolve = await run("gh", [
    "api", "graphql",
    "-f", `query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}`,
    "-f", `t=${threadId}`,
  ]);
  return { replied: reply.code === 0, resolved: resolve.code === 0 };
}

// File (in the repo root) the session writes its per-thread decisions to; the dashboard
// reads it to post tailored replies, then deletes it before committing (never committed).
const DECISIONS_FILE = ".dashboard-review-decisions.json";

function addressReviewPrompt(nwo, branch, threads) {
  const blocks = threads
    .map((t, i) => `### ${i + 1}. id=${t.id}\n${t.path}:${t.line || "?"} — ${t.isCopilot ? "Copilot" : "@" + t.author}\n${t.body}\n${t.diffHunk ? `\nDiff context:\n\`\`\`\n${t.diffHunk}\n\`\`\`` : ""}`)
    .join("\n\n");
  return [
    `A pull request on \`${nwo}\` (branch \`${branch}\`, already checked out here) has the review comments below. For EACH one, re-assess it on its merits and decide the best path forward — don't blindly apply it. Reviewers (especially automated ones like Copilot) are sometimes wrong, out of date, or out of scope for a dependency-update PR.`,
    ``,
    `## Review comments`,
    ``,
    blocks,
    ``,
    `## For each comment, decide`,
    `- **fix** — the comment is correct/worthwhile: make the SMALLEST reasonable code change that addresses it (or its clear intent).`,
    `- **reject** — the comment is incorrect, based on a misunderstanding, already handled, or genuinely out of scope: make NO code change for it. You'll explain why in your decision note (the dashboard posts it as a reply and resolves the thread).`,
    `When unsure, lean toward a careful fix — but a confident, specific reason to reject is fine and better than a bogus change.`,
    ``,
    `## Guidance`,
    `- Run tools through the repo's pinned toolchain via mise: \`mise exec -- <cmd>\`. If you touch dependencies, regenerate the lockfile.`,
    `- Keep every diff minimal and on-point. Don't change application logic beyond what a comment requires.`,
    ``,
    `## Record your decisions (REQUIRED)`,
    `Write a file \`${DECISIONS_FILE}\` in the repo root: a JSON array with ONE entry per comment above, using its given id:`,
    `\`\`\`json`,
    `[{ "id": "<the id>", "action": "fix" | "reject", "note": "<for fix: one line on what you changed; for reject: why the comment is wrong / not applicable>" }]`,
    `\`\`\``,
    `Keep notes concise and reviewer-facing (they're posted as the reply on each thread). Cover every comment exactly once.`,
    ``,
    `## Finish`,
    `\`git add\` ONLY the source files your fixes touched — NOT \`${DECISIONS_FILE}\` (the dashboard reads and removes it) and never tracker/state files (\`.beads/\`, editor configs, \`.DS_Store\`). Commit with a concise message like \`chore: address review feedback\`. Do NOT push or open a PR — the dashboard pushes and replies to/resolves the threads.`,
  ].join("\n");
}

/**
 * Address selected review threads on a PR: check out the branch, run one headless session
 * over all of them, push, then reply-to + resolve each addressed thread.
 * @param {{config, repo, number, threadIds:string[], emit}} a
 */
async function createAddressReviewPR({ config, repo, number, threadIds, emit }) {
  const { nwo, dir, workRoot, log, step, onLn, sh } = await jobContext({ config, repo, emit });
  const ids = new Set(threadIds || []);
  const all = await fetchReviewThreads(nwo, number);
  const threads = all.filter((t) => ids.has(t.id) && !t.isResolved);
  if (!threads.length) {
    log("No selected, unresolved review threads to address — nothing to do.", "warn");
    emit("done", { changed: false, number });
    return { changed: false, number };
  }

  step("Preparing checkout");
  if (!exists(path.join(dir, ".git"))) {
    if (exists(dir)) await fs.rm(dir, { recursive: true, force: true });
    log(`$ gh repo clone ${nwo} ${dir}`);
    await stream("gh", ["repo", "clone", nwo, dir], { cwd: workRoot }, onLn);
  }
  log(`$ gh pr checkout ${number}`);
  const co = await sh("gh", ["pr", "checkout", String(number), "--repo", nwo, "--force"]);
  if (co !== 0) { emit("error", { message: "Couldn't check out the PR branch — aborting." }); return { ok: false }; }
  const branch = (await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const before = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

  step("Claude session");
  const c = config.claudeReview || config.claudeFix || {};
  const session = { mode: c.permissionMode || "auto", effort: c.effort || "high", model: c.model || undefined, timeoutMin: c.timeoutMinutes || 25 };
  log(`$ claude -p --permission-mode ${session.mode} --effort ${session.effort}  (addressing ${threads.length} review comment(s))`, "warn");
  await runClaude({ prompt: addressReviewPrompt(nwo, branch, threads), cwd: dir, log, ...session });

  // Read the session's per-thread decisions (fix vs reject + note), then remove the file so
  // it's never committed. Defensive parse → empty map → generic fallback replies.
  step("Reading decisions");
  const decisions = {};
  const decPath = path.join(dir, DECISIONS_FILE);
  try {
    const raw = await fs.readFile(decPath, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const d of arr) if (d && d.id) decisions[d.id] = { action: d.action === "reject" ? "reject" : "fix", note: String(d.note || "").slice(0, 500) };
  } catch { /* no/invalid decisions file — fall back to generic replies */ }
  await fs.rm(decPath, { force: true }).catch(() => {});
  const hasDecisions = Object.keys(decisions).length > 0;

  step("Checking for changes");
  await run("git", ["-C", dir, "add", "-A"]);
  const junkStaged = (await run("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout
    .split("\n").filter(Boolean).filter(isJunkPath);
  if (junkStaged.length) {
    log(`Excluding tracker/state file(s) from the commit: ${junkStaged.join(", ")}`, "warn");
    await run("git", ["-C", dir, "reset", "-q", "HEAD", "--", ...junkStaged]);
  }
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) await run("git", ["-C", dir, "commit", "-m", "chore: address review feedback"]);
  const after = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  const committed = after !== before;
  // No commit AND no decisions → the session did nothing useful; leave the threads open.
  // (A reject-only run legitimately produces no commit but still has decisions to post.)
  if (!committed && !hasDecisions) {
    log("Claude made no change and recorded no decisions — leaving the threads open for a manual look.", "warn");
    emit("done", { changed: false, number });
    return { changed: false, number };
  }

  let pushed = false;
  if (committed) {
    step("Pushing branch");
    log(`$ git push origin HEAD:${branch}`);
    const pc = await sh("git", ["push", "origin", `HEAD:${branch}`]);
    pushed = pc === 0;
    if (!pushed) { log("Couldn't push the fixes — leaving threads open.", "warn"); emit("done", { changed: true, pushed: false, number }); return { changed: true, pushed: false }; }
  } else {
    log("No code change to push (all addressed comments were assessed as not needing one).", "warn");
  }

  // Reply to + resolve each thread, tailoring the note: a fix cites the commit + what changed;
  // a reject explains why it wasn't applied; threads with no decision get a generic note.
  step("Replying to + resolving threads");
  const sha7 = after.slice(0, 7);
  const resolved = [];
  let fixedN = 0, rejectedN = 0;
  for (const t of threads) {
    const d = decisions[t.id];
    let body;
    if (d && d.action === "reject") {
      body = `Not applying this suggestion — ${d.note || "assessed as incorrect or out of scope."}\n\n_(Automated assessment by the Headway Dependency Dashboard; reopen if you disagree.)_`;
      rejectedN++;
    } else if (d && d.action === "fix") {
      body = `Addressed in ${sha7}${d.note ? ` — ${d.note}` : ""}.`;
      fixedN++;
    } else {
      body = committed ? `Addressed in ${sha7} by the Dependency Dashboard.` : `Reviewed — no change needed.`;
    }
    const r = await replyAndResolveThread(t.id, body);
    if (r.resolved) { resolved.push(t.id); log(`✓ ${d && d.action === "reject" ? "rejected + resolved" : "addressed + resolved"} ${t.path}:${t.line || "?"}`); }
    else log(`⚠ couldn't resolve thread on ${t.path}:${t.line || "?"}`, "warn");
  }

  log(`\nDone: ${fixedN} fixed, ${rejectedN} rejected with a reason, ${resolved.length}/${threads.length} thread(s) resolved${committed ? `, pushed ${sha7} to ${branch} (CI will re-run)` : " (no code change needed)"}.`);
  emit("done", { changed: committed, pushed, number, sha: after, resolved, fixed: fixedN, rejected: rejectedN });
  return { changed: committed, pushed, number, sha: after, resolved };
}

module.exports = {
  fetchReviewThreads,
  countOpenReviewThreads,
  investigateThreads,
  createAddressReviewPR,
  addressReviewPrompt,
  isCopilotLogin,
};
