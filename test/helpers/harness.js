"use strict";

// Boot the REAL server.js against the stub `gh`, so tests exercise the actual route code
// rather than a reimplementation of it. Two things make that safe to do repeatedly:
//
//   1. The server runs from a COPY in a temp dir. server.js resolves everything from its own
//      __dirname — config.json, the git-ignored state files, bootstrapLocalFiles() — so
//      running it in place would read your real config and write to your real state.
//   2. `gh` is a stub first on PATH, so nothing reaches GitHub.
//
// Each test gets its own server and its own temp dir; nothing is shared, so a route that
// mutates the model cache (merge does) can't leak into the next test.

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const STUB_BIN = path.join(__dirname, "bin");

/** An OS-assigned free port, so parallel test files don't collide on a hardcoded one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const DEFAULT_CONFIG = {
  org: "acme-corp",
  host: "127.0.0.1",
  hexScan: false, // the Hex scan is a separate subsystem; keep merge tests to the merge path
  autoFixCI: false,
  autoUpgradeEOL: false,
  autoFixGemConstraints: false,
  // Push every poller past the end of any test run. A poll firing mid-test would mutate the
  // model underneath the request being asserted on.
  ciPollSeconds: 36000,
  eolPollHours: 999,
  sequencePollSeconds: 36000,
};

/**
 * Start a server. Returns a handle with `request()` for calling routes, `ghArgs()` for the
 * commands the stub saw, and `stop()`. Always stop it — `t.after(() => server.stop())`.
 *
 * @param {{config?: object, scenario?: string}} opts
 *   config    merged over the defaults (e.g. { mergeMethod: "rebase" })
 *   scenario  which fixture variation the stub serves (see test/helpers/bin/gh)
 */
async function startServer({ config = {}, scenario = "default" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-dashboard-test-"));
  const stubDir = path.join(dir, "stub");
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, "scenario"), scenario);
  fs.writeFileSync(path.join(stubDir, "gh.log"), "");
  fs.writeFileSync(path.join(stubDir, "claude.log"), "");

  const port = await freePort();
  const merged = { ...DEFAULT_CONFIG, ...config, port };
  fs.copyFileSync(path.join(REPO_ROOT, "server.js"), path.join(dir, "server.js"));
  fs.cpSync(path.join(REPO_ROOT, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(merged, null, 2));

  const child = spawn(process.execPath, [path.join(dir, "server.js")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}`,
      GH_STUB_DIR: stubDir,
      GH_STUB_ORG: merged.org,
      PORT: String(port),
    },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${log}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start within 15s:\n${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    url,
    /** Call a route; resolves { status, body } with the body parsed when it's JSON. */
    async request(route, { method = "GET", body } = {}) {
      const res = await fetch(url + route, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    /** Every `gh` invocation so far, as argv strings — the record tests assert against. */
    ghArgs() {
      return fs.readFileSync(path.join(stubDir, "gh.log"), "utf8").split("\n").filter(Boolean);
    },
    /** The single `gh` invocation starting with these words, or null. Fails loudly on 2+. */
    ghCall(...prefix) {
      const hits = this.ghArgs().filter((line) => line.startsWith(prefix.join(" ")));
      if (hits.length > 1) throw new Error(`expected one \`gh ${prefix.join(" ")}\`, saw ${hits.length}:\n${hits.join("\n")}`);
      return hits[0] || null;
    },
    /** Every `claude` invocation. Usually asserted EMPTY — no test should launch a session. */
    claudeArgs() {
      return fs.readFileSync(path.join(stubDir, "claude.log"), "utf8").split("\n").filter(Boolean);
    },
    /**
     * Poll a background job to completion. Routes that start jobs answer immediately with a
     * jobId, so a test that asserts right away is racing the work it means to observe.
     * Resolves the job record once it is done/error, or throws on timeout.
     */
    async waitForJob(jobId, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { body } = await this.request("/api/jobs");
        const job = (body.jobs || []).find((j) => j.id === jobId);
        if (job && (job.status === "done" || job.status === "error")) return job;
        if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms (status: ${job && job.status})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /**
     * Subscribe to the job event stream. Call BEFORE the route that starts the job — the
     * server replays a still-active job's buffered events on connect, but a job that already
     * finished is gone. Returns { lines, logText, close }.
     */
    async events() {
      const lines = [];
      let buf = "";
      // Resolve only once the stream's opening `hello` has arrived, not merely once headers
      // have. The route writes hello and THEN registers the client, so returning on headers
      // leaves a window where a job started immediately afterwards emits into a subscriber
      // list we are not in yet — and the events are simply lost.
      return await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              if (!line.trim()) continue;
              try { lines.push(JSON.parse(line)); } catch { /* partial frame */ }
              if (lines.length === 1) {
                resolve({
                  lines,
                  /** Just the human-readable log lines, in order — what the card would show. */
                  logText: () => lines.filter((e) => e.line).map((e) => e.line),
                  close: () => req.destroy(),
                });
              }
            }
          });
        });
        req.on("error", reject);
        setTimeout(() => reject(new Error("event stream did not open in 5s")), 5000).unref();
      });
    },
    serverLog: () => log,
    stop() {
      child.kill();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows/AV holds */ }
    },
  };
}

module.exports = { startServer };
