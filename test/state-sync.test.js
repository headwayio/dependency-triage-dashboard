"use strict";

// lib/statesync.js — committing and pushing the state repo between machines.
//
// Real git against a temp bare "remote" with two clones standing in for two machines, so
// the push/pull/rebase behaviour under test is git's own. The one property that matters
// most: sync NEVER overwrites the other machine's work — a conflict pauses it with both
// sides intact rather than force-pushing.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Isolate git from the developer's own config (signing, hooks, default branch) — set
// before requiring the module, which snapshots the environment for its git calls.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "state-sync-test-"));
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { createStateSync, describeChanges } = require("../lib/statesync");

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const json = (root, data) => JSON.stringify({ [root]: data }, null, 2) + "\n";
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const quiet = () => {};

/** A bare remote seeded with one classification, plus `n` clones of it. */
function setup(t, n = 2) {
  const base = fs.mkdtempSync(path.join(TMP, "case-"));
  const remote = path.join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const seed = path.join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" }); // "cloned an empty repository"
  write(seed, "classifications.json", json("classifications", { alpha: { state: "monitored", at: "t0" } }));
  write(seed, "compliance.json", json("compliance", {}));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Seed");
  git(seed, "push", "-q", "-u", "origin", "main");
  const clones = Array.from({ length: n }, (_, i) => {
    const dir = path.join(base, `machine-${i}`);
    execFileSync("git", ["clone", "-q", remote, dir]);
    return dir;
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { remote, clones };
}

const sync = (dir, opts = {}) => createStateSync({ dir, host: "test-host", log: quiet, ...opts });
const remoteLog = (remote) => git(remote, "log", "--format=%s", "main").split("\n");

// ---- commit messages -------------------------------------------------------------

test("names a single classification in the subject, with the engagement note in the body", () => {
  const msg = describeChanges([
    {
      file: "classifications.json",
      before: json("classifications", {}),
      after: json("classifications", { "dashmkt-platform": { state: "maintained", at: "t1" } }),
    },
    {
      file: "engagement-log.json",
      before: json("log", {}),
      after: json("log", { "dashmkt-platform": [{ at: "t1", to: "maintained", note: "Going live soon" }] }),
    },
  ], "omarchy");
  const [subject, , ...body] = msg.split("\n");
  assert.equal(subject, "Classify dashmkt-platform as maintained");
  assert.ok(body.includes("- Log dashmkt-platform's engagement change: Going live soon"));
  assert.match(msg, /Synced-from: omarchy\n$/);
});

test("summarises bulk triage instead of listing it in the subject", () => {
  const entries = Object.fromEntries(["a", "b", "c"].map((r) => [r, { state: "ignored", at: "t" }]));
  const msg = describeChanges([{ file: "classifications.json", before: json("classifications", {}), after: json("classifications", entries) }]);
  assert.equal(msg.split("\n")[0], "Classify 3 repos");
  assert.match(msg, /- Classify b as ignored/);
});

test("describes removals, unchanged entries are left out", () => {
  const msg = describeChanges([{
    file: "compliance.json",
    before: json("compliance", { keep: { state: "out-of-scope" }, gone: { state: "needs-compliance" } }),
    after: json("compliance", { keep: { state: "out-of-scope" } }),
  }]);
  assert.equal(msg.split("\n")[0], "Clear the compliance decision for gone");
  assert.doesNotMatch(msg, /keep/);
});

test("bookkeeping reaches the subject only when nothing else changed", () => {
  const msg = describeChanges([{ file: "fix-attempts.json", before: json("attempts", {}), after: json("attempts", { "api#42": 1 }) }]);
  assert.equal(msg.split("\n")[0], "Count a CI fix attempt for api");
});

test("falls back to a file-level line for config and unparseable files", () => {
  const msg = describeChanges([
    { file: "config.json", before: "{}", after: '{"org":"x"}' },
    { file: "classifications.json", before: "{", after: "{ broken" },
  ]);
  assert.equal(msg.split("\n")[0], "Update the dashboard config (+1 more)");
  assert.match(msg, /- Update classifications\.json/);
});

// ---- syncing ---------------------------------------------------------------------

test("commits and pushes a save with a descriptive message", async (t) => {
  const { remote, clones: [a] } = setup(t, 1);
  const s = sync(a);
  write(a, "classifications.json", json("classifications", { alpha: { state: "maintained", at: "t1" } }));
  await s.flush();
  assert.equal(remoteLog(remote)[0], "Classify alpha as maintained");
  assert.ok(s.status().lastPushAt);
  assert.equal(s.status().error, null);
});

test("a burst of saves becomes one commit", async (t) => {
  const { remote, clones: [a] } = setup(t, 1);
  const s = sync(a, { debounceMs: 50 });
  for (const r of ["b", "c", "d"]) {
    const d = JSON.parse(fs.readFileSync(path.join(a, "classifications.json"), "utf8")).classifications;
    write(a, "classifications.json", json("classifications", { ...d, [r]: { state: "ignored", at: "t" } }));
    s.touched();
  }
  await new Promise((r) => setTimeout(r, 300));
  await s.flush(); // drains the debounced sync; nothing new to commit
  assert.deepEqual(remoteLog(remote), ["Classify 3 repos", "Seed"]);
});

test("startup pulls the other machine's changes", async (t) => {
  const { clones: [a, b] } = setup(t);
  write(a, "compliance.json", json("compliance", { alpha: { state: "out-of-scope", at: "t" } }));
  await sync(a).flush();

  const s = sync(b);
  s.pullAtStartup();
  await s.flush();
  assert.match(fs.readFileSync(path.join(b, "compliance.json"), "utf8"), /out-of-scope/);
});

test("startup commits changes a crashed run left behind, then pushes them", async (t) => {
  const { remote, clones: [a] } = setup(t, 1);
  write(a, "compliance.json", json("compliance", { alpha: { state: "out-of-scope", at: "t" } }));
  const s = sync(a);
  s.pullAtStartup();
  await s.flush();
  assert.equal(remoteLog(remote)[0], "Commit state left unsynced by the last run");
  assert.equal(git(a, "status", "--porcelain"), "");
});

test("rebases onto the other machine's push when they touched different files", async (t) => {
  const { remote, clones: [a, b] } = setup(t);
  write(a, "classifications.json", json("classifications", { alpha: { state: "maintained", at: "t1" } }));
  await sync(a).flush();

  write(b, "compliance.json", json("compliance", { alpha: { state: "out-of-scope", at: "t2" } }));
  const s = sync(b);
  await s.flush();
  assert.deepEqual(remoteLog(remote), ["Mark alpha out-of-scope", "Classify alpha as maintained", "Seed"]);
  assert.equal(s.status().paused, null);
});

test("a conflict pauses sync and never overwrites the other machine's push", async (t) => {
  const { remote, clones: [a, b] } = setup(t);
  write(a, "classifications.json", json("classifications", { alpha: { state: "maintained", at: "t1" } }));
  await sync(a).flush();
  const remoteHead = git(remote, "rev-parse", "main");

  write(b, "classifications.json", json("classifications", { alpha: { state: "ignored", at: "t2" } }));
  const s = sync(b);
  await s.flush();

  assert.match(s.status().paused, /same state file/);
  assert.equal(git(remote, "rev-parse", "main"), remoteHead, "remote untouched");
  assert.equal(git(b, "log", "-1", "--format=%s"), "Classify alpha as ignored", "local commit kept");
  assert.equal(git(b, "status", "--porcelain"), "", "rebase aborted cleanly");

  // Paused means paused: later saves don't try again until a restart.
  write(b, "compliance.json", json("compliance", { alpha: { state: "out-of-scope", at: "t3" } }));
  await s.flush();
  assert.equal(git(b, "log", "-1", "--format=%s"), "Classify alpha as ignored");
});

test("an unreachable remote is an error to retry, not a pause, and keeps the commit", async (t) => {
  const { remote, clones: [a] } = setup(t, 1);
  fs.renameSync(remote, remote + ".offline"); // setup()'s cleanup removes it either way

  write(a, "classifications.json", json("classifications", { alpha: { state: "maintained", at: "t1" } }));
  const s = sync(a);
  await s.flush();
  assert.match(s.status().error, /Couldn't push or pull/);
  assert.equal(s.status().paused, null);
  assert.equal(git(a, "log", "-1", "--format=%s"), "Classify alpha as maintained");
});
