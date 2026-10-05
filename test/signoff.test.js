"use strict";

// lib/signoff.js — when the poller signs off a tool PR, and the private Postgres it runs on.
//
// The decision is pure so it can be pinned here; the run itself (clone, setup, the repo's
// bin/signoff-browser, the status it posts) is exercised end to end against a real repo.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { shouldStartSignoff, signoffConclusion, ensurePostgres, CONTEXT } = require("../lib/signoff");
const { describeChanges } = require("../lib/statesync");

const ready = { enabled: true, capable: true, headSha: "abc123", awaitingFix: false, checks: [], attempted: false, busy: false };

test("signs off a tool PR head that has no signoff yet", () => {
  assert.equal(shouldStartSignoff(ready), true);
  assert.equal(shouldStartSignoff({ ...ready, checks: [{ name: CONTEXT, conclusion: "FAILURE" }] }), true, "a stale failure is re-signed");
});

test("signs off a failing PR that auto-fix won't touch, when the repo requires only the signoff", () => {
  assert.equal(shouldStartSignoff({ ...ready, awaitingFix: false }), true);
});

test("leaves alone what is off, unsupported, signed, attempted, failing, or busy", () => {
  assert.equal(shouldStartSignoff({ ...ready, enabled: false }), false);
  assert.equal(shouldStartSignoff({ ...ready, capable: false }), false);
  assert.equal(shouldStartSignoff({ ...ready, headSha: null }), false);
  assert.equal(shouldStartSignoff({ ...ready, checks: [{ name: CONTEXT, conclusion: "SUCCESS" }] }), false);
  assert.equal(shouldStartSignoff({ ...ready, attempted: true }), false, "one run per commit");
  assert.equal(shouldStartSignoff({ ...ready, awaitingFix: true }), false, "auto-fix will push a new head");
  assert.equal(shouldStartSignoff({ ...ready, busy: true }), false, "another job may move the branch");
});

test("reads the signoff context out of the PR's checks", () => {
  assert.equal(signoffConclusion([{ name: "test", conclusion: "SUCCESS" }]), null);
  assert.equal(signoffConclusion([{ name: CONTEXT, conclusion: "SUCCESS" }]), "SUCCESS");
  assert.equal(signoffConclusion([{ name: CONTEXT, conclusion: "" }]), "PENDING");
});

test("signoff attempts sync as bookkeeping with a readable line", () => {
  const msg = describeChanges([{
    file: "signoff-attempts.json",
    before: JSON.stringify({ attempts: {} }),
    after: JSON.stringify({ attempts: { "crows-nest@857ec63": { result: "failed", at: "t" } } }),
  }]);
  assert.equal(msg.split("\n")[0], "Record a failed browser signoff for crows-nest");
});

const havePg = spawnSync("initdb", ["--version"]).status === 0;

test("the private Postgres is socket-only and reused across runs", { skip: !havePg && "initdb not installed" }, async (t) => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-pg-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  const data = path.join(workRoot, ".signoff-pg", "data");
  t.after(() => {
    spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
    fs.rmSync(workRoot, { recursive: true, force: true });
  });
  const lines = [];
  const env = await ensurePostgres({ workRoot, port, log: (l) => lines.push(l) });
  assert.equal(env.PGPORT, String(port));
  const ping = spawnSync("psql", ["-h", env.PGHOST, "-p", env.PGPORT, "-d", "postgres", "-Atc", "show listen_addresses"], { encoding: "utf8" });
  assert.equal(ping.stdout.trim(), "", "no TCP listener");

  lines.length = 0;
  await ensurePostgres({ workRoot, port, log: (l) => lines.push(l) });
  assert.deepEqual(lines, [], "second call neither re-inits nor restarts");
});
