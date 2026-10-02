"use strict";

// Optional git sync for the local state files (classifications, compliance, contacts, …).
//
// The state files are git-ignored here because this repo is public. To share them between
// machines, keep them in a separate (private) git repo, symlink each one into this checkout,
// and point `stateRepo` in config.json at that repo. Then:
//
//   - on startup, pull the state repo BEFORE config.json is loaded (config.json usually
//     lives in the state repo too, so a pull can change it);
//   - after each save, wait `stateSyncSeconds` for the burst to settle (bulk triage writes
//     dozens of times in a row), then commit with a message naming what changed and push;
//   - on Ctrl+C / a watch restart, commit and push whatever is pending before exiting, so
//     switching machines right after stopping doesn't strand the last changes.
//
// It never force-pushes. If the other machine pushed first, our commits are rebased onto
// it; if that conflicts (both machines changed the same file), the rebase is aborted, our
// commits stay local, and sync PAUSES until the conflict is resolved by hand — surfaced in
// the dashboard banner, not just the log. A network failure is not a pause: it's retried.
//
// Writes go through symlinks: fs.writeFileSync follows them, so the stores in state.js
// edit the state repo's working tree directly and only need to call touched() afterwards.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawnSync } = require("child_process");

const GIT_TIMEOUT_MS = 20000; // a hung ssh prompt or dead network can't wedge the queue
const EXIT_TIMEOUT_MS = 15000; // most we hold up Ctrl+C to push the last changes
const RETRY_MS = 5 * 60 * 1000; // after a network failure, try again even with no new saves
const BODY_LINES = 50;

// Never let git block on a credential prompt: there's no terminal to answer it.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

// ---- Commit messages ----------------------------------------------------------
// Each store maps a changed entry to one line of the commit message. `minor` stores are
// bookkeeping (attempt counters, job history, the engagement log that rides along with a
// classification): they're listed in the body but only reach the subject when nothing
// else changed, so a classify commit reads "Classify X as maintained", not "Log X …".

/** Repo name from a store key — bookkeeping keys look like `repo#123` or `repo@pkg@1.2`. */
const repoOf = (key) => String(key).split(/[#@]/)[0];

const STORES = {
  "classifications.json": {
    root: "classifications",
    line: (k, a) => (a ? `Classify ${k} as ${a.state}` : `Unclassify ${k}`),
    many: (n) => `Classify ${n} repos`,
  },
  "compliance.json": {
    root: "compliance",
    line: (k, a) => (a ? `Mark ${k} ${a.state}` : `Clear the compliance decision for ${k}`),
    many: (n) => `Record ${n} compliance decisions`,
  },
  "scope-overrides.json": {
    root: "overrides",
    line: (k, a) => (a ? `Set ${k}'s audit scope to ${a.scope}${a.reason ? ` (${a.reason})` : ""}` : `Clear the scope override for ${k}`),
  },
  "contacts.json": { root: "contacts", line: (k, a) => (a ? `Update the client contact for ${k}` : `Remove the client contact for ${k}`) },
  "notifications.json": { root: "notifications", line: (k, a) => (a ? `Record a client notice for ${k}` : `Clear the client notice for ${k}`) },
  "dismissals.json": { root: "dismissals", line: (k) => `Record the alert dismissal for ${k}` },
  "dispositions.json": { root: "dispositions", line: (k, a) => (a ? `Record ${k}'s disposition as ${a.state}` : `Clear ${k}'s disposition`) },
  "ignored.json": { root: "ignored", line: (k, a) => (a ? `Ignore ${k}` : `Stop ignoring ${k}`) },
  "engagement-log.json": {
    root: "log",
    minor: true,
    line: (k, a) => {
      const last = Array.isArray(a) && a[a.length - 1];
      return last && last.note ? `Log ${k}'s engagement change: ${last.note}` : `Log ${k}'s engagement change`;
    },
  },
  "session-history.json": { root: "sessions", minor: true, line: (k) => `Record job history for ${k}` },
  "fix-attempts.json": { root: "attempts", minor: true, line: (k) => `Count a CI fix attempt for ${repoOf(k)}` },
  "upgrade-attempts.json": { root: "upgrades", minor: true, line: (k) => `Record a runtime upgrade attempt for ${repoOf(k)}` },
  "bump-attempts.json": { root: "bumps", minor: true, line: (k) => `Record a constraint bump attempt for ${repoOf(k)}` },
  "blocked.json": { root: "blocked", minor: true, line: (k) => `Update the blocked dependencies for ${k}` },
  "pr-links.json": { root: "links", minor: true, line: (k) => `Update the PR links for ${repoOf(k)}` },
  "dependabot-nudges.json": { root: "nudges", minor: true, line: (k) => `Record a Dependabot nudge for ${repoOf(k)}` },
};

const FILE_LINES = { "config.json": "Update the dashboard config", "settings.toml": "Update the dashboard settings" };

function parseRoot(text, root) {
  if (text == null) return {};
  const d = JSON.parse(text);
  return (d && d[root]) || {};
}

/** One message line per changed entry: [{store, minor, text}]. */
function changeLines({ file, before, after }) {
  const store = STORES[file];
  if (store) {
    try {
      const b = parseRoot(before, store.root);
      const a = parseRoot(after, store.root);
      const out = [];
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
        out.push({ store: file, minor: !!store.minor, text: store.line(k, a[k], b[k]) });
      }
      if (out.length) return out;
    } catch {
      /* unparseable — fall through to the file-level line */
    }
  }
  if (before == null && after != null) return [{ store: file, minor: false, text: `Add ${file}` }];
  if (after == null) return [{ store: file, minor: false, text: `Remove ${file}` }];
  return [{ store: file, minor: !!(store && store.minor), text: FILE_LINES[file] || `Update ${file}` }];
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Build a commit message from the changed files' before/after contents.
 * @param {{file:string, before:string|null, after:string|null}[]} changes
 */
function describeChanges(changes, host = os.hostname()) {
  const lines = changes.flatMap(changeLines);
  const major = lines.filter((l) => !l.minor);
  const lead = major.length ? major : lines;
  let subject;
  if (lead.length === 1) subject = lead[0].text;
  else {
    const stores = new Set(lead.map((l) => l.store));
    const many = stores.size === 1 && STORES[lead[0].store] && STORES[lead[0].store].many;
    subject = many ? many(lead.length) : `${lead[0].text} (+${lead.length - 1} more)`;
  }
  const ordered = [...major, ...lines.filter((l) => l.minor)].map((l) => `- ${l.text}`);
  const body = ordered.length > BODY_LINES
    ? [...ordered.slice(0, BODY_LINES), `- … and ${ordered.length - BODY_LINES} more`]
    : ordered;
  return `${clip(subject, 72)}\n\n${body.join("\n")}\n\nSynced-from: ${host}\n`;
}

// ---- The sync engine ------------------------------------------------------------

/**
 * @param {{dir:string, debounceMs?:number, host?:string, log?:(line:string)=>void}} opts
 */
function createStateSync({ dir, debounceMs = 30000, host = os.hostname(), log = (l) => console.log(l) }) {
  const status = { enabled: true, dir, paused: null, error: null, lastPushAt: null };
  let timer = null;
  let retry = null;
  let chain = Promise.resolve(); // serializes every git operation — they share one index

  const gitSync = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: GIT_ENV });
    return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? r.error.message : "") };
  };
  const git = (args) =>
    new Promise((resolve) => {
      execFile("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr: stderr || (err ? err.message : "") });
      });
    });
  const firstLine = (r) => (r.stderr || r.stdout).trim().split("\n").pop() || `git exited ${r.code}`;
  const rebasing = () => {
    const p = gitSync(["rev-parse", "--git-path", "rebase-merge"]).stdout.trim();
    return !!p && fs.existsSync(path.resolve(dir, p));
  };

  function pause(why) {
    status.paused = `${why} Resolve it in ${dir} (git pull --rebase, fix the conflict, push), then restart the dashboard. Changes are still saved locally.`;
    log(`  ⚠ State sync paused: ${status.paused}`);
  }

  function fail(what, r) {
    status.error = `${what}: ${firstLine(r)}`;
    log(`  ⚠ State sync: ${status.error} — will retry`);
    clearTimeout(retry);
    retry = setTimeout(() => enqueue(syncNow), RETRY_MS);
    retry.unref();
  }

  /** Pull before config.json is read. Synchronous on purpose: it runs before the server starts. */
  function pullAtStartup() {
    const dirty = gitSync(["status", "--porcelain"]).stdout.trim();
    if (dirty) {
      // Left over from a run that died before it could sync. Commit first so the rebase
      // below carries it, rather than a stash that could fail to re-apply.
      const files = dirty.split("\n").map((l) => `- ${l.slice(3)}`).join("\n");
      gitSync(["add", "-A"]);
      gitSync(["commit", "-q", "-m", `Commit state left unsynced by the last run\n\n${files}\n\nSynced-from: ${host}\n`]);
    }
    const r = gitSync(["pull", "--rebase", "-q"]);
    if (r.code !== 0) {
      if (rebasing()) {
        gitSync(["rebase", "--abort"]);
        pause("Pulling the state repo conflicted with unsynced local changes.");
      } else {
        status.error = `Couldn't pull the state repo: ${firstLine(r)} — running on the local copy`;
        log(`  ⚠ ${status.error}`);
      }
    }
    enqueue(syncNow); // push anything committed above, or stranded by an earlier failure
  }

  /** Files that differ from HEAD, with both versions for the commit message. */
  async function pendingChanges() {
    const r = await git(["status", "--porcelain", "-z", "--untracked-files=all"]);
    const files = r.stdout.split("\0").filter(Boolean).map((e) => e.slice(3));
    return Promise.all(
      files.map(async (file) => {
        const head = await git(["show", `HEAD:${file}`]);
        let after = null;
        try { after = fs.readFileSync(path.join(dir, file), "utf8"); } catch {}
        return { file, before: head.code === 0 ? head.stdout : null, after };
      })
    );
  }

  async function syncNow() {
    if (status.paused) return;
    const changes = await pendingChanges();
    if (changes.length) {
      await git(["add", "-A"]);
      const c = await git(["commit", "-q", "-m", describeChanges(changes, host)]);
      if (c.code !== 0) return fail("Couldn't commit", c);
    }
    const ahead = await git(["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead.code !== 0) return fail("Couldn't compare with the remote (no upstream branch?)", ahead);
    if (Number(ahead.stdout.trim()) === 0) {
      status.error = null;
      return;
    }
    let push = await git(["push", "-q"]);
    if (push.code !== 0) {
      // Usually the other machine pushed first: replay our commits on top of it and retry.
      const pull = await git(["pull", "--rebase", "-q"]);
      if (pull.code !== 0) {
        if (rebasing()) {
          await git(["rebase", "--abort"]);
          return pause("The other machine changed the same state file.");
        }
        return fail("Couldn't push or pull", push);
      }
      push = await git(["push", "-q"]);
      if (push.code !== 0) return fail("Couldn't push", push);
    }
    status.error = null;
    status.lastPushAt = new Date().toISOString();
  }

  function enqueue(fn) {
    chain = chain.then(fn).catch((e) => {
      status.error = e.message;
      log(`  ⚠ State sync: ${e.message}`);
    });
    return chain;
  }

  /** A state file was just written — sync once writes have been quiet for debounceMs. */
  function touched() {
    if (status.paused) return;
    clearTimeout(timer);
    timer = setTimeout(() => enqueue(syncNow), debounceMs);
    timer.unref();
  }

  /** Sync now, skipping the debounce (waits for any sync already running). */
  function flush() {
    clearTimeout(timer);
    return enqueue(syncNow);
  }

  return { pullAtStartup, touched, flush, status: () => ({ ...status }) };
}

// ---- Process-wide instance --------------------------------------------------------
// server.js calls start() once; the stores call touched() after every write. With no
// stateRepo configured, everything here is a no-op.

let instance = null;
let startError = null;

/** Read the sync settings straight from config.json — this runs before loadConfig(). */
function peekConfig(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    return { stateRepo: raw.stateRepo, stateSyncSeconds: raw.stateSyncSeconds };
  } catch {
    return {};
  }
}

function start(root) {
  const { stateRepo, stateSyncSeconds } = peekConfig(root);
  if (!stateRepo) return;
  const dir = path.resolve(root, String(stateRepo).replace(/^~(?=$|\/)/, os.homedir()));
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    startError = `stateRepo ${dir} is not a git repository, so state sync is off.`;
    console.log(`  ⚠ ${startError}`);
    return;
  }
  const seconds = Number(stateSyncSeconds ?? 30);
  instance = createStateSync({ dir, debounceMs: Math.max(0, Number.isFinite(seconds) ? seconds : 30) * 1000 });
  instance.pullAtStartup();

  // Push pending changes before exiting. `once`: a second Ctrl+C gets the default
  // behaviour and exits immediately, sync or not.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, async () => {
      console.log("\n  Syncing state before exit…");
      const timeout = new Promise((r) => setTimeout(r, EXIT_TIMEOUT_MS).unref());
      await Promise.race([instance.flush(), timeout]);
      process.kill(process.pid, sig);
    });
  }
}

function touched() {
  if (instance) instance.touched();
}

function status() {
  if (instance) return instance.status();
  return { enabled: false, error: startError };
}

module.exports = { start, touched, status, createStateSync, describeChanges };
