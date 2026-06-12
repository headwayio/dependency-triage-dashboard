"use strict";

// CI status + failure-log retrieval for a PR, via the `gh` CLI. Read-only.

const { run } = require("./exec");

const FAIL = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/**
 * CI rollup for one PR.
 * @returns {{state:"passing"|"failing"|"pending"|"none"|"unknown", headSha:string|null,
 *            isDraft:boolean, checks:Array, failing:Array}}
 */
async function fetchPRStatus(nwo, prNumber) {
  const res = await run("gh", [
    "pr", "view", String(prNumber), "--repo", nwo,
    "--json", "statusCheckRollup,headRefOid,isDraft,state,reviewDecision,reviewRequests",
  ]);
  if (res.code !== 0) return { state: "unknown", headSha: null, isDraft: false, reviewDecision: null, reviewers: [], checks: [], failing: [], error: (res.stderr || "").trim() };

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { state: "unknown", headSha: null, isDraft: false, reviewDecision: null, reviewers: [], checks: [], failing: [] };
  }

  const checks = (data.statusCheckRollup || []).map((c) => {
    // CheckRun: {name,status,conclusion,detailsUrl}; StatusContext: {context,state,targetUrl}
    const name = c.name || c.context || "check";
    const conclusion = String(c.conclusion || c.state || "").toUpperCase();
    const status = String(c.status || "").toUpperCase();
    const url = c.detailsUrl || c.targetUrl || "";
    const jobId = (url.match(/\/job\/(\d+)/) || [])[1] || null;
    return { name, conclusion, status, url, jobId };
  });

  const isFail = (c) => FAIL.has(c.conclusion);
  const isPending = (c) => !c.conclusion || c.conclusion === "PENDING" || c.status === "QUEUED" || c.status === "IN_PROGRESS" || c.status === "WAITING";
  const failing = checks.filter(isFail);

  let state;
  if (!checks.length) state = "none";
  else if (failing.length) state = "failing";
  else if (checks.some(isPending)) state = "pending";
  else state = "passing";

  return {
    state,
    headSha: data.headRefOid || null,
    isDraft: !!data.isDraft,
    reviewDecision: data.reviewDecision || null,
    reviewers: (data.reviewRequests || []).map((x) => x.login || x.slug || x.name).filter(Boolean),
    checks,
    failing,
  };
}

/**
 * Concise error excerpt per failing check: strips the leading ISO timestamps and
 * the post-job git-cleanup noise, then keeps the meaningful tail (where the error is).
 */
async function fetchFailingLogs(nwo, failing, maxLinesPerCheck = 45) {
  const out = [];
  for (const f of failing) {
    if (!f.jobId) {
      out.push({ name: f.name, log: `(no job id — see ${f.url})` });
      continue;
    }
    const res = await run("gh", ["api", `repos/${nwo}/actions/jobs/${f.jobId}/logs`]);
    if (res.code !== 0) {
      out.push({ name: f.name, log: `(couldn't fetch logs: ${(res.stderr || "").trim().slice(0, 200)})` });
      continue;
    }
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(/^\S+Z\s/, "")) // drop the leading ISO timestamp GH adds
      .filter((l) => l.trim());
    const cut = lines.findIndex((l) => /Post job cleanup/.test(l)); // everything after is git/runner cleanup
    const body = cut >= 0 ? lines.slice(0, cut) : lines;
    out.push({ name: f.name, log: body.slice(-maxLinesPerCheck).join("\n") });
  }
  return out;
}

module.exports = { fetchPRStatus, fetchFailingLogs };
