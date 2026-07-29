"use strict";

// Open Dependabot VERSION-update PRs surfaced on the model.
//
// These are the routine bumps the tool deliberately never acts on — no advisory behind them,
// so auto-merging arbitrary majors would dilute the audit trail. Not acting is the policy;
// not *showing* them was an accident, and it meant the only way to notice a repo was 40
// versions behind was to browse GitHub repo by repo.
//
// The assertions lean on the split rather than the total: `github_actions` bumps are CI
// plumbing, while an app dependency drifting many majors is what eventually makes a security
// patch unappliable. A count that mixed them would read as one number and mean two things.

const { test } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helpers/harness");

const REPO = "data-pipeline";

/** The repo's model entry after a build. */
async function repoModel(t, opts = {}) {
  const server = await startServer(opts);
  t.after(() => server.stop());
  const { body } = await server.request("/api/repos");
  return { repo: body.repos.find((r) => r.name === REPO), server };
}

test("summarizes open Dependabot PRs, split by what they actually are", async (t) => {
  const { repo } = await repoModel(t);
  const d = repo.dependabotPRs;
  assert.ok(d, "expected a dependabotPRs summary on the repo");
  assert.equal(d.total, 4);
  assert.equal(d.app, 3, "bundler + npm are application dependencies");
  assert.equal(d.infra, 1, "actions/checkout is CI plumbing, counted apart");
  assert.deepEqual(d.byEcosystem, { bundler: 2, npm_and_yarn: 1, github_actions: 1 });
});

test("counts majors, parsed from Dependabot's own title", async (t) => {
  const { repo } = await repoModel(t);
  // puma 7.2.1 → 8.0.2 and actions/checkout 4 → 7. jbuilder is a minor, sortablejs a patch.
  assert.equal(repo.dependabotPRs.major, 2);
  const puma = repo.dependabotPRs.prs.find((p) => p.number === 201);
  assert.deepEqual(
    { pkg: puma.pkg, from: puma.from, to: puma.to, bump: puma.bump },
    { pkg: "puma", from: "7.2.1", to: "8.0.2", bump: "major" }
  );
});

test("only a definite failure counts as failing", async (t) => {
  const { repo } = await repoModel(t);
  // #202 is red. #203 has NO checks at all, which is not the same as failing — counting it
  // would make the number mean "PRs I haven't looked at" rather than "PRs that are broken".
  assert.equal(repo.dependabotPRs.failing, 1);
  assert.equal(repo.dependabotPRs.prs.find((p) => p.number === 203).failing, false);
});

test("reports the oldest PR, since age is the thing that hurts", async (t) => {
  const { repo } = await repoModel(t);
  assert.equal(repo.dependabotPRs.oldestAt, "2026-05-02T00:00:00.000Z");
  assert.equal(repo.dependabotPRs.prs[0].number, 201, "oldest first");
});

test("Dependabot PRs never enter openPRs — the tool must not act on them", async (t) => {
  const { repo } = await repoModel(t);
  const numbers = (repo.openPRs || []).map((p) => p.number);
  assert.deepEqual(numbers, [57], "only our own tool PR");
  for (const p of repo.openPRs || []) {
    assert.ok(!p.headRefName.startsWith("dependabot/"), `${p.headRefName} must not be treated as ours`);
  }
});

test("surfaces the backlog even when we have no PR of our own open", async (t) => {
  // The case it matters most: nothing of ours draws the eye to the repo, so an accumulating
  // backlog is invisible. The summary is built before the no-tool-PRs bail-out for this reason.
  const { repo } = await repoModel(t, { scenario: "only-dependabot" });
  assert.equal(repo.pending, false);
  assert.deepEqual(repo.openPRs, []);
  assert.equal(repo.dependabotPRs.total, 4);
});

test("no Dependabot PRs means no summary, not an empty one", async (t) => {
  const { repo } = await repoModel(t, { scenario: "no-dependabot-prs" });
  assert.equal(repo.dependabotPRs, null, "a zero-count object would render an empty badge");
});

test("costs no extra request — it reuses the listing the model build already makes", async (t) => {
  const { server } = await repoModel(t);
  // The whole justification for surfacing these is that `fetchToolPRs` already had them in
  // hand and threw them away. If the model build starts issuing its own author-filtered
  // query, that justification is gone and this should fail.
  const authorQueries = server.ghArgs().filter((l) => l.includes("--author app/dependabot"));
  assert.deepEqual(authorQueries, [], `model build should not query Dependabot separately:\n${authorQueries.join("\n")}`);
  const listings = server.ghArgs().filter((l) => l.startsWith(`pr list --repo acme-corp/${REPO} --state open`));
  assert.equal(listings.length, 1, "one listing serves both our PRs and the Dependabot summary");
});
