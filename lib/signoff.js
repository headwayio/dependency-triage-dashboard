"use strict";

// Browser signoff for the PRs this tool opens.
//
// Some repos gate merging on a `signoff/browser` commit status that only a local run can
// post: their bin/signoff-browser runs the full browser suite on the exact pushed commit,
// then `gh signoff` marks it green. When a repo carries that script, the CI poller runs it
// for each tool PR's head commit, so a PR the dashboard opens doesn't sit unmergeable until
// someone checks it out and signs off by hand. A new head (a CI fix, a rebase) gets a new
// run; a commit whose run failed isn't retried (see state.signoffAttempted).
//
// Isolation: each run uses a fresh clone at .work/signoff/<repo> and a PRIVATE Postgres
// cluster at .work/.signoff-pg that listens on a Unix socket only. A repo's test databases
// have fixed names and its test-lease locks live in its own git directory, so a run from a
// separate clone against the shared server could collide with another checkout's tests.
// Runs are serialized: the suite drives a browser per worker and saturates the CPU.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { run, stream } = require("./exec");

const SCRIPT = "bin/signoff-browser";
const CONTEXT = "signoff/browser";
const ASSET_TASKS = ["tailwindcss:build", "css:build", "javascript:build"];

/** The signoff context's conclusion on a PR head (SUCCESS, FAILURE, …), or null if absent. */
function signoffConclusion(checks) {
  const c = (checks || []).find((x) => x.name === CONTEXT);
  return c ? c.conclusion || "PENDING" : null;
}

/**
 * Whether the poller should start a signoff for this PR head. Pure, so the rules are
 * testable apart from the poller.
 *  - awaitingFix: CI is failing and auto-fix still has budget for this commit, so a new
 *    head is coming and signing this one is wasted work. Failing CI alone doesn't block:
 *    a repo may require only the signoff, and with auto-fix off or spent nothing else
 *    would ever sign the PR.
 *  - Another job on the repo (an update, a fix, a signoff) may move the branch; wait.
 *  - Already signed (GitHub has the status) or already attempted here: nothing to do.
 */
function shouldStartSignoff({ enabled, capable, headSha, awaitingFix, checks, attempted, busy }) {
  if (!enabled || !capable || !headSha) return false;
  if (awaitingFix || busy || attempted) return false;
  return signoffConclusion(checks) !== "SUCCESS";
}

/** The app-server port a repo's Capybara config pins, if any (`server_port = 9887 + …`). */
function capybaraBasePort(dir) {
  for (const f of ["spec/support/capybara.rb", "spec/rails_helper.rb", "test/application_system_test_case.rb"]) {
    let src = "";
    try { src = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    const m = src.match(/server_port\s*=\s*(\d{2,5})/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Whether anything is already listening on 127.0.0.1 at any port in [from, to]. */
async function portsBusy(from, to) {
  const busy = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(true));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(false)));
    });
  for (let p = from; p <= to; p++) if (await busy(p)) return true;
  return false;
}

/** An error the runner should not record as a failed signoff: the next poll retries. */
function retryLater(message) {
  const e = new Error(message);
  e.retryLater = true;
  return e;
}

// Unix socket paths are capped at 107 bytes. A dashboard cloned somewhere deep would
// exceed that with the socket under .work, so fall back to a short per-user directory.
const SOCKET_PATH_MAX = 107;

function pgPaths(workRoot, port) {
  const base = path.join(workRoot, ".signoff-pg");
  let sock = path.join(base, "run");
  if (path.join(sock, `.s.PGSQL.${port}`).length > SOCKET_PATH_MAX) {
    sock = path.join(os.tmpdir(), `signoff-pg-${process.getuid ? process.getuid() : "user"}-${port}`);
  }
  return { base, data: path.join(base, "data"), sock, log: path.join(base, "postgres.log"), port: String(port) };
}

/** Create (once) and start the private cluster; idempotent. Returns libpq env for it. */
async function ensurePostgres({ workRoot, port, log }) {
  const pg = pgPaths(workRoot, port);
  fs.mkdirSync(pg.sock, { recursive: true, mode: 0o700 });
  fs.chmodSync(pg.sock, 0o700); // only this user may reach the socket, wherever it lives
  if (!fs.existsSync(path.join(pg.data, "PG_VERSION"))) {
    log(`$ initdb ${pg.data}   (private signoff Postgres, socket-only)`);
    const user = process.env.USER || "postgres";
    const init = await run("initdb", ["-D", pg.data, "-A", "trust", "-U", user, "--no-instructions"]);
    if (init.code !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout).trim().split("\n").pop()}`);
  }
  // listen_addresses='' → no TCP at all; only this user can reach the socket directory.
  const opts = `-k ${pg.sock} -p ${pg.port} -c listen_addresses=''`;
  if ((await run("pg_ctl", ["-D", pg.data, "status"])).code !== 0) {
    log(`$ pg_ctl start   (port ${pg.port}, socket ${pg.sock})`);
    const start = await run("pg_ctl", ["-D", pg.data, "-l", pg.log, "-w", "-o", opts, "start"]);
    if (start.code !== 0) throw new Error(`Couldn't start the signoff Postgres — see ${pg.log}`);
  }
  return { PGHOST: pg.sock, PGPORT: pg.port };
}

/**
 * Run the repo's browser signoff on `sha` (the PR head on `branch`). Resolves
 * { signed: true } once bin/signoff-browser has posted signoff/browser; throws on a
 * failing suite or setup problem, with the reason in the job log.
 */
async function runSignoff({ config, repo, branch, sha, emit }) {
  const log = (line, level = "info") => emit("log", { line, level });
  const step = (name) => emit("step", { name });
  const onLn = (line, which) => log(line, which === "stderr" ? "warn" : "info");
  const nwo = `${config.org}/${repo.name}`;
  const workRoot = path.resolve(__dirname, "..", config.workDir || ".work");
  const root = path.join(workRoot, "signoff");
  const dir = path.join(root, repo.name);
  fs.mkdirSync(root, { recursive: true });

  step("Starting the private test database");
  const pgEnv = await ensurePostgres({ workRoot, port: config.signoffPgPort || 55433, log });
  const env = { ...process.env, ...pgEnv, MISE_YES: "1" };
  const sh = async (label, cmd, args) => {
    log(`$ ${label}`);
    const code = await stream(cmd, args, { cwd: dir, env }, onLn);
    if (code !== 0) throw new Error(`${label} exited ${code}`);
  };
  const has = (f) => fs.existsSync(path.join(dir, f));

  step(`Cloning ${branch}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const clone = await stream("gh", ["repo", "clone", nwo, dir, "--", "--branch", branch, "--depth=1"], { cwd: root, env }, onLn);
  if (clone !== 0) throw new Error(`gh repo clone exited ${clone}`);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  // The poller saw `sha`; if the branch has moved since, sign off nothing — the next poll
  // sees the new head and starts a run for it.
  if (head !== sha) throw retryLater(`${branch} moved to ${head.slice(0, 8)} (expected ${sha.slice(0, 8)}); the next poll signs off the new head`);
  if (!has(SCRIPT)) throw new Error(`${SCRIPT} is not on ${branch}`);

  step("Preparing the toolchain and test databases");
  if (has(".tool-versions") || has(".mise.toml") || has(".ruby-version") || has(".node-version")) {
    await sh("mise install", "mise", ["install"]);
  }
  const exec = (label, args) => sh(label, "mise", ["exec", "--", ...args]);
  if (has("Gemfile")) await exec("bundle install", ["bundle", "install", "--quiet"]);
  // Worker databases for the parallel browser run, then the main test database the
  // serial re-run of failures uses. Both land on the private cluster via PGHOST/PGPORT.
  if (has("bin/test-parallel-prepare")) await exec("bin/test-parallel-prepare", ["bin/test-parallel-prepare"]);
  if (has("bin/rails")) await sh("RAILS_ENV=test bin/rails db:prepare", "mise", ["exec", "--", "env", "RAILS_ENV=test", "bin/rails", "db:prepare"]);
  // Compiled assets are build output a fresh clone doesn't have. Without them the suite
  // renders unstyled pages and nearly every interaction fails (clicks land on whatever
  // overlaps the target). A developer checkout has them from bin/dev; CI builds them
  // explicitly. Build with whichever asset tasks the app defines.
  if (has("bin/rails")) {
    const tasks = (await run("mise", ["exec", "--", "bin/rails", "-T"], { cwd: dir, env })).stdout;
    for (const task of ASSET_TASKS) {
      if (new RegExp(`^bin/rails ${task}\\b`, "m").test(tasks)) {
        await sh(`bin/rails ${task}`, "mise", ["exec", "--", "env", "RAILS_ENV=test", "bin/rails", task]);
      }
    }
  }

  // Isolated databases don't isolate ports: some suites pin their app server's port per
  // worker (crows-nest: 9887 + worker number), so another checkout's browser run on the
  // same machine could serve our browser its app and its database. Wait it out.
  const base = capybaraBasePort(dir);
  if (base && (await portsBusy(base, base + 16))) {
    throw retryLater(`Test ports ${base}–${base + 16} are in use (another browser run?); retrying on a later poll`);
  }

  step("Running the browser suite and signing off");
  await exec(SCRIPT, [SCRIPT]);
  log(`✓ Signed off ${sha.slice(0, 8)} — ${CONTEXT} is green on GitHub.`);
  return { signed: true, sha };
}

module.exports = { SCRIPT, CONTEXT, signoffConclusion, shouldStartSignoff, ensurePostgres, runSignoff, capybaraBasePort, portsBusy, pgPaths };
