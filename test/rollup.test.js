"use strict";

// POST /api/rollup — consolidate a repo's ready PRs into one release PR.
//
// Rollup CLOSES the PRs it consolidates. That makes its SELECTION the highest-stakes decision
// in the app: sweeping in a PR this tool didn't open would close someone else's work. Most of
// what follows is therefore about what the route refuses to select, and the sharpest case is
// "human PR + one tool PR" — the error says *found 1*, which proves the human PR was filtered
// out rather than merely outnumbered.
//
// The route answers immediately with a job id and does the work in the background, so tests
// come in two layers: the response for the selection, and the job's event log for what the
// session actually did with it.

const { test } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helpers/harness");

const REPO = "data-pipeline";

// The mixed fixture: 57 + 90 are eligible tool PRs; 58 is a human's branch, 60 has changes
// requested, 61 is a draft, 300 is itself a release rollup, and 201 is one of Dependabot's
// own version-update PRs. Only 57 and 90 may ever land in a rollup.
const MIX = { scenario: "rollup-mix" };
const ELIGIBLE = [57, 90];

async function rollup(t, { scenario = "default", config, ...body } = {}) {
  const server = await startServer({ scenario, config });
  t.after(() => server.stop());
  const res = await server.request("/api/rollup", { method: "POST", body: { repo: REPO, ...body } });
  return { ...res, server };
}

test("rolls up the eligible tool PRs and starts a job", async (t) => {
  const { status, body, server } = await rollup(t, { ...MIX, numbers: ELIGIBLE });
  assert.equal(status, 200);
  assert.equal(body.prs, 2);
  assert.match(body.jobId, /^rollup-/);

  const jobs = await server.request("/api/jobs");
  assert.equal(jobs.body.jobs.length, 1);
  assert.equal(jobs.body.jobs[0].repo, REPO);
});

test("selects only eligible PRs even when asked for every open one", async (t) => {
  // The client sends the cluster it displayed; the server must still apply its own filter.
  const { status, body } = await rollup(t, { ...MIX, numbers: [57, 90, 58, 60, 61, 300] });
  assert.equal(status, 200);
  assert.equal(body.prs, 2, "human, changes-requested, draft and release PRs must all be dropped");
});

test("refuses to roll up a PR this tool did not open", async (t) => {
  const { status, body, server } = await rollup(t, { ...MIX, numbers: [58] });
  assert.equal(status, 409);
  assert.match(body.error, /found 0/, "a human's PR is not a rollup candidate at all");
  assert.equal((await server.request("/api/jobs")).body.jobs.length, 0);
});

test("does not count a human PR toward the two-PR minimum", async (t) => {
  // The sharp one. If the tool-branch filter were dropped this would report found 2 and
  // proceed — and the rollup would later CLOSE #58, which belongs to someone else.
  const { status, body } = await rollup(t, { ...MIX, numbers: [58, 57] });
  assert.equal(status, 409);
  assert.match(body.error, /found 1/);
});

test("does not count a Dependabot PR toward the two-PR minimum", async (t) => {
  // Same mechanism as the human-PR case above — `dependabot/` is not a tool-branch prefix —
  // but this is the realistic version of it. A colleague's feature branch sitting beside a
  // rollup cluster is occasional; Dependabot PRs are in every repo, often a dozen at a time.
  // And a rollup CLOSES its inputs, so the failure here would be closing a Dependabot PR:
  // routine-looking, unattributed, and far likelier to go unnoticed than closing a person's.
  const { status, body } = await rollup(t, { ...MIX, numbers: [201, 57] });
  assert.equal(status, 409);
  assert.match(body.error, /found 1/);
});

test("refuses when the repo has only one eligible PR", async (t) => {
  const { status, body, server } = await rollup(t, { scenario: "rollup-one" });
  assert.equal(status, 409);
  assert.match(body.error, /at least two/);
  assert.equal((await server.request("/api/jobs")).body.jobs.length, 0, "no job may start");
});

test("rolls up every eligible PR when the caller sends no numbers", async (t) => {
  // Legacy/fallback path: an older client posts no cluster, so the server picks the eligible
  // set itself — and must apply exactly the same filter.
  const { status, body } = await rollup(t, MIX);
  assert.equal(status, 200);
  assert.equal(body.prs, 2);
});

test("rejects an invalid repo name before doing anything", async (t) => {
  const { status } = await rollup(t, { ...MIX, repo: "../../etc/passwd", numbers: ELIGIBLE });
  assert.ok(status >= 400, `expected a refusal, got ${status}`);
});

// ---- what the job then does --------------------------------------------------
test("merges the branches in the order the caller chose", async (t) => {
  // Order is the whole point of letting the user drag the cluster: it decides which upgrade
  // lands first and therefore which conflicts surface. Only the job log reveals it, and the
  // per-PR line is emitted whether or not the fetch succeeds.
  const server = await startServer({ scenario: "tool-child" });
  t.after(() => server.stop());
  const events = await server.events();
  t.after(() => events.close());

  // Deliberately the REVERSE of the fixture's listing order ([90, 57]). Requesting the order
  // gh already returns would make the sort a no-op, and the test would pass with the sort
  // deleted — proving nothing.
  const { body } = await server.request("/api/rollup", { method: "POST", body: { repo: REPO, numbers: [57, 90] } });
  await server.waitForJob(body.jobId);

  const seen = events.logText().join("\n").match(/PR #(\d+)/g);
  assert.deepEqual(seen.slice(0, 2), ["PR #57", "PR #90"], "must follow the caller's order, not gh's listing order");
});

test("skips when a release PR is already open for today's branch", async (t) => {
  const server = await startServer({ scenario: "release-pr-open" });
  t.after(() => server.stop());
  const events = await server.events();
  t.after(() => events.close());

  const { body } = await server.request("/api/rollup", { method: "POST", body: { repo: REPO, numbers: ELIGIBLE } });
  const job = await server.waitForJob(body.jobId);

  assert.equal(job.status, "done");
  assert.match(events.logText().join("\n"), /already open for release\/deps-.*#300.*skipping/);
  assert.equal(server.ghCall("repo", "clone"), null, "skipping must happen before the clone");
});

test("aborts cleanly, without a Claude session, when no branch can be fetched", async (t) => {
  const server = await startServer({ scenario: "tool-child" });
  t.after(() => server.stop());
  const events = await server.events();
  t.after(() => events.close());

  const { body } = await server.request("/api/rollup", { method: "POST", body: { repo: REPO, numbers: ELIGIBLE } });
  const job = await server.waitForJob(body.jobId);

  assert.equal(job.status, "done", "an abort is a clean finish, not a crashed job");
  assert.match(events.logText().join("\n"), /None of the PR branches could be fetched/);
  assert.equal(job.prUrl, null, "nothing may be opened when nothing could be merged");
  assert.deepEqual(server.claudeArgs(), [], "no work to do means no session — sessions cost money");
});

test("does not start a second job while one is already running for the repo", async (t) => {
  // slow-clone stalls the job inside its clone step, so the first job is provably still
  // running when the second request lands — no reliance on winning a race.
  const server = await startServer({ scenario: "slow-clone" });
  t.after(() => server.stop());
  const post = () => server.request("/api/rollup", { method: "POST", body: { repo: REPO, numbers: ELIGIBLE } });
  const [first, second] = await Promise.all([post(), post()]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.jobId, first.body.jobId, "the second call must join the running job");
  assert.equal((await server.request("/api/jobs")).body.jobs.length, 1);
});
