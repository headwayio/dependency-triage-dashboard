"use strict";

// CI status + failure-log retrieval for a PR, via the `gh` CLI. Read-only.

const { run } = require("./exec");

const FAIL = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const UNKNOWN = { state: "unknown", headSha: null, isDraft: false, reviewDecision: null, reviewers: [], mergeable: null, mergeStateStatus: null, baseRefName: null, reviewUnresolved: 0, checks: [], failing: [] };

// Normalize one rollup context (REST CheckRun/StatusContext shape OR GraphQL node) to a
// flat check. CheckRun: {name,status,conclusion,detailsUrl}; StatusContext: {context,state,targetUrl}.
function mapCheck(c) {
  const name = c.name || c.context || "check";
  const conclusion = String(c.conclusion || c.state || "").toUpperCase();
  const status = String(c.status || "").toUpperCase();
  const url = c.detailsUrl || c.targetUrl || "";
  const jobId = (url.match(/\/job\/(\d+)/) || [])[1] || null;
  return { name, conclusion, status, url, jobId };
}
const isFail = (c) => FAIL.has(c.conclusion);
const isPending = (c) => !c.conclusion || c.conclusion === "PENDING" || c.status === "QUEUED" || c.status === "IN_PROGRESS" || c.status === "WAITING";

// Roll a check list up into a single state + the failing subset.
function rollup(checks) {
  const failing = checks.filter(isFail);
  let state;
  if (!checks.length) state = "none";
  else if (failing.length) state = "failing";
  else if (checks.some(isPending)) state = "pending";
  else state = "passing";
  return { state, failing };
}

/**
 * CI rollup for one PR (single `gh pr view`). Used for one-off checks (e.g. fix-ci).
 * @returns {{state, headSha, isDraft, reviewDecision, reviewers, checks, failing}}
 */
async function fetchPRStatus(nwo, prNumber) {
  const res = await run("gh", [
    "pr", "view", String(prNumber), "--repo", nwo,
    "--json", "statusCheckRollup,headRefOid,isDraft,state,reviewDecision,reviewRequests,mergeable,mergeStateStatus,baseRefName",
  ]);
  if (res.code !== 0) return { ...UNKNOWN, error: (res.stderr || "").trim() };
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { ...UNKNOWN };
  }
  const checks = (data.statusCheckRollup || []).map(mapCheck);
  const { state, failing } = rollup(checks);
  return {
    state,
    headSha: data.headRefOid || null,
    isDraft: !!data.isDraft,
    reviewDecision: data.reviewDecision || null,
    reviewers: (data.reviewRequests || []).map((x) => x.login || x.slug || x.name).filter(Boolean),
    mergeable: data.mergeable || null,
    mergeStateStatus: data.mergeStateStatus || null,
    baseRefName: data.baseRefName || null,
    reviewUnresolved: 0, // gh pr view --json doesn't expose reviewThreads; batch path fills this
    checks,
    failing,
  };
}

/**
 * CI + review status for MANY PRs in ONE GraphQL call (aliased repository/pullRequest
 * blocks), so the poller scales to one request per cycle instead of one `gh pr view`
 * per PR. `prs` = [{ nwo, number }]. Returns a Map keyed `nwo#number` → same shape as
 * fetchPRStatus, or null on a total failure so callers can fall back to per-PR.
 */
async function fetchPRStatusBatch(prs) {
  const out = new Map();
  if (!prs || !prs.length) return out;
  const fragment =
    "fragment prState on PullRequest { isDraft reviewDecision headRefOid mergeable mergeStateStatus baseRefName " +
    "reviewThreads(first: 50) { nodes { isResolved isOutdated } } " +
    "reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name } } } } " +
    "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename " +
    "... on CheckRun { name status conclusion detailsUrl } " +
    "... on StatusContext { context state targetUrl } } } } } } } }";
  const blocks = prs
    .map((p, i) => {
      const slash = String(p.nwo).indexOf("/");
      const owner = String(p.nwo).slice(0, slash);
      const repo = String(p.nwo).slice(slash + 1);
      return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${Number(p.number)}) { ...prState } }`;
    })
    .join("\n");
  const query = `query {\n${blocks}\n}\n${fragment}`;
  const res = await run("gh", ["api", "graphql", "-f", `query=${query}`]);
  if (res.code !== 0) return null; // total failure — let the caller fall back to per-PR
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return null;
  }
  const data = parsed.data || {};
  prs.forEach((p, i) => {
    const node = data[`p${i}`] && data[`p${i}`].pullRequest;
    if (!node) {
      out.set(`${p.nwo}#${p.number}`, { ...UNKNOWN });
      return;
    }
    const ctxNodes = (((node.commits || {}).nodes || [])[0]?.commit?.statusCheckRollup?.contexts?.nodes) || [];
    const checks = ctxNodes.map(mapCheck);
    const { state, failing } = rollup(checks);
    const reviewers = ((node.reviewRequests || {}).nodes || [])
      .map((x) => x.requestedReviewer && (x.requestedReviewer.login || x.requestedReviewer.slug || x.requestedReviewer.name))
      .filter(Boolean);
    out.set(`${p.nwo}#${p.number}`, {
      state,
      headSha: node.headRefOid || null,
      isDraft: !!node.isDraft,
      reviewDecision: node.reviewDecision || null,
      reviewers,
      mergeable: node.mergeable || null,
      mergeStateStatus: node.mergeStateStatus || null,
      baseRefName: node.baseRefName || null,
      reviewUnresolved: (((node.reviewThreads || {}).nodes) || []).filter((t) => !t.isResolved && !t.isOutdated).length,
      checks,
      failing,
    });
  });
  return out;
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

module.exports = { fetchPRStatus, fetchPRStatusBatch, fetchFailingLogs };
