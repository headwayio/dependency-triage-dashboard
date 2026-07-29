"use strict";

// The unresolved-review-thread count that decides whether a PR shows its 💬 Review button.
//
// The bug this covers: the count excluded threads marked OUTDATED as well as resolved ones.
// A thread goes outdated when the line it was anchored to changes — which this tool causes
// constantly, since every CI fix, rebase and rollup rewrites lines. So a PR with real,
// unaddressed Copilot feedback would quietly show no review button at all, and the only way
// to find the comments was to open GitHub. Outdated means the code MOVED, not that anyone
// answered the comment; GitHub still counts these as unresolved conversations.

const { test } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helpers/harness");

const REPO = "data-pipeline";

/** Force one CI/review poll and hand back the PR metadata it produced. */
async function pollFor(t, number) {
  const server = await startServer();
  t.after(() => server.stop());
  await server.request("/api/repos"); // build the model so the poll has PRs to ask about
  const { body } = await server.request("/api/pr-status?refresh=1");
  const prs = (body.prMeta || {})[REPO] || [];
  return { pr: prs.find((p) => p.number === number), body, server };
}

test("counts an unresolved thread whose anchor line has moved", async (t) => {
  // PR 57's fixture has three threads: one plainly open, one open-but-outdated, one resolved.
  // Two are unaddressed, so two is the count — the outdated one is the whole point.
  const { pr } = await pollFor(t, 57);
  assert.ok(pr, "expected PR 57 in the poll's metadata");
  assert.equal(pr.reviewUnresolved, 2);
});

test("never counts a resolved thread, outdated or not", async (t) => {
  // PR 90's only thread is resolved. Resolved is the one state that genuinely means done.
  const server = await startServer({ scenario: "tool-child" });
  t.after(() => server.stop());
  await server.request("/api/repos");
  const { body } = await server.request("/api/pr-status?refresh=1");
  const pr = ((body.prMeta || {})[REPO] || []).find((p) => p.number === 90);
  assert.ok(pr, "expected PR 90 in the poll's metadata");
  assert.equal(pr.reviewUnresolved, 0);
});

test("an approved PR still reports its unresolved threads", async (t) => {
  // The reported symptom was on an APPROVED PR, and approval is exactly when this bites:
  // by then the branch has usually been pushed to, so its threads have gone outdated.
  // Approval must not suppress the count — the two are unrelated.
  const { pr } = await pollFor(t, 57);
  assert.equal(pr.reviewDecision, "APPROVED");
  assert.equal(pr.reviewUnresolved, 2, "approval says nothing about whether comments were addressed");
});
