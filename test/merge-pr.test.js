"use strict";

// POST /api/merge-pr — the Approved tab's Merge button.
//
// Merging is irreversible, so most of these assert on what the route REFUSES, and on the exact
// `gh pr merge` argv it produced. Asserting the response body alone would only prove the server
// reported a merge; asserting the argv proves it asked for the right one — `--squash` vs
// `--merge`, `--delete-branch` or not — which is where the real bugs live.

const { test } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helpers/harness");

const REPO = "data-pipeline";
const NWO = "acme-corp/data-pipeline";

/** Run one merge against a fresh server and hand the test the result plus the gh record. */
async function merge(t, { number = 57, config, scenario } = {}) {
  const server = await startServer({ config, scenario });
  t.after(() => server.stop());
  const res = await server.request("/api/merge-pr", { method: "POST", body: { repo: REPO, number } });
  return { ...res, server, mergeCall: server.ghCall("pr", "merge") };
}

test("merges an approved tool PR, squashing and deleting the branch", async (t) => {
  const { status, body, mergeCall } = await merge(t);
  assert.equal(status, 200);
  assert.equal(body.merged, true);
  assert.equal(body.method, "squash");
  assert.equal(body.branchDeleted, true);
  assert.equal(body.base, "main");
  assert.equal(mergeCall, `pr merge 57 --repo ${NWO} --squash --delete-branch`);
});

test("drops the merged PR from the model so the repo leaves the PR tabs", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const before = await server.request("/api/repos");
  const repoBefore = before.body.repos.find((r) => r.name === REPO);
  assert.equal(repoBefore.pending, true);
  assert.deepEqual(repoBefore.openPRs.map((p) => p.number), [57]);

  await server.request("/api/merge-pr", { method: "POST", body: { repo: REPO, number: 57 } });

  const after = await server.request("/api/repos");
  const repoAfter = after.body.repos.find((r) => r.name === REPO);
  assert.deepEqual(repoAfter.openPRs, []);
  assert.equal(repoAfter.pending, false, "a repo with no open tool PR must not stay pending");
});

// ---- refusals: nothing may reach `gh pr merge` -------------------------------
for (const [name, number, expect] of [
  ["a branch this tool didn't open", 58, /isn't a branch this tool opened/],
  ["a PR that already merged", 59, /is merged, not open/],
  ["a PR with changes requested", 60, /changes requested/],
  ["a draft PR", 61, /still a draft/],
]) {
  test(`refuses ${name}`, async (t) => {
    const { status, body, mergeCall } = await merge(t, { number });
    assert.equal(status, 409);
    assert.match(body.error, expect);
    assert.equal(mergeCall, null, "refusal must not invoke gh pr merge");
  });
}

test("rejects a non-numeric PR number before touching gh", async (t) => {
  const { status, body, mergeCall } = await merge(t, { number: 0 });
  assert.equal(status, 400);
  assert.match(body.error, /Valid PR number required/);
  assert.equal(mergeCall, null);
});

// ---- merge-method negotiation ------------------------------------------------
// `gh pr merge --squash` errors outright on a squash-disabled repo, so the route reads the
// repo's capabilities first and falls back rather than assuming.
for (const [name, scenario, method] of [
  ["falls back to a merge commit when squash is disabled", "no-squash", "merge"],
  ["falls back to rebase when only rebase is allowed", "rebase-only", "rebase"],
]) {
  test(name, async (t) => {
    const { status, body, mergeCall } = await merge(t, { scenario });
    assert.equal(status, 200);
    assert.equal(body.method, method);
    assert.match(mergeCall, new RegExp(`--${method}(\\s|$)`));
  });
}

test("refuses when the repo allows no merge method at all", async (t) => {
  const { status, body, mergeCall } = await merge(t, { scenario: "none-allowed" });
  assert.equal(status, 409);
  assert.match(body.error, /allows no merge method/);
  assert.equal(mergeCall, null);
});

test("still tries the preferred method when capabilities are unreadable", async (t) => {
  // Distinct from none-allowed: we couldn't tell, so proceed and let GitHub decide. Reading
  // "unreadable" as "nothing allowed" would refuse a merge that is perfectly legal.
  const { status, body } = await merge(t, { scenario: "caps-unreadable" });
  assert.equal(status, 200);
  assert.equal(body.method, "squash");
});

for (const [configured, expected] of [["merge", "merge"], ["rebase", "rebase"], ["octopus", "squash"]])
  test(`honors mergeMethod: ${configured}`, async (t) => {
    const { status, body, mergeCall } = await merge(t, { config: { mergeMethod: configured } });
    assert.equal(status, 200);
    assert.equal(body.method, expected, "an unrecognised method falls back to squash");
    assert.match(mergeCall, new RegExp(`--${expected}(\\s|$)`));
  });

test("honors deleteBranchOnMerge: false", async (t) => {
  const { status, body, mergeCall } = await merge(t, { config: { deleteBranchOnMerge: false } });
  assert.equal(status, 200);
  assert.equal(body.branchDeleted, false);
  assert.ok(!mergeCall.includes("--delete-branch"));
});

// ---- stacks ------------------------------------------------------------------
// A stacked child is built ON this PR's commits. Squash and rebase replace them with new
// hashes, leaving the child carrying commits its base no longer has — its diff balloons to
// re-include this PR's changes and it conflicts. A merge commit keeps them reachable.
for (const [name, scenario, child] of [
  ["one of ours", "tool-child", 90],
  ["a human's, invisible to the model cache", "human-child", 99],
]) {
  test(`uses a merge commit and keeps the branch when a PR is stacked on it — ${name}`, async (t) => {
    const { status, body, mergeCall } = await merge(t, { scenario });
    assert.equal(status, 200);
    assert.equal(body.method, "merge", "squash would strand the stacked child");
    assert.equal(body.branchDeleted, false, "deleting the branch could close the child");
    assert.deepEqual(body.stackedChildren, [child]);
    assert.equal(mergeCall, `pr merge 57 --repo ${NWO} --merge`);
  });
}

test("overrides even an explicitly configured squash for a stack parent", async (t) => {
  const { body } = await merge(t, { scenario: "tool-child", config: { mergeMethod: "squash" } });
  assert.equal(body.method, "merge");
});

// ---- failures from GitHub ----------------------------------------------------
test("surfaces GitHub's refusal verbatim instead of a generic error", async (t) => {
  const { status, body, mergeCall } = await merge(t, { scenario: "merge-blocked" });
  assert.equal(status, 502);
  assert.match(body.error, /required status checks have not passed/);
  assert.ok(mergeCall, "we did attempt the merge — GitHub is what refused it");
});

test("surfaces a failure to read the PR", async (t) => {
  const { status, body, mergeCall } = await merge(t, { scenario: "view-fails" });
  assert.equal(status, 502);
  assert.match(body.error, /could not resolve to a PullRequest/);
  assert.equal(mergeCall, null);
});

test("never passes --admin, which would bypass branch protection", async (t) => {
  const { server } = await merge(t);
  assert.ok(!server.ghArgs().some((line) => line.includes("--admin")));
});
