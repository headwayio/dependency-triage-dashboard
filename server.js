#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const gh = require("./lib/github");
const state = require("./lib/state");
const settingsStore = require("./lib/settings");
const { createUpdatePR } = require("./lib/updater");
const { buildClientEmail } = require("./lib/email");
const { run } = require("./lib/exec");
const ci = require("./lib/ci");
const { createFixSession } = require("./lib/fixer");
const { createConstraintBumpPR } = require("./lib/bumper");
const eol = require("./lib/eol");
const protection = require("./lib/protection");

// ---- Config -----------------------------------------------------------------
const ROOT = __dirname;
const createdLocalFiles = bootstrapLocalFiles();
const config = loadConfig();
const HOST = process.env.HOST || config.host || "127.0.0.1";
const PORT = Number(process.env.PORT || config.port || 8787);

// First-run bootstrap: for every `*.example.*` template at the repo root, create the
// real (git-ignored) file if it doesn't exist yet — so a fresh clone starts with a
// working config + empty state files and no manual `cp` step. Existing files are
// never touched. Returns the list of filenames created (for the startup banner).
function bootstrapLocalFiles() {
  const created = [];
  let entries;
  try {
    entries = fs.readdirSync(ROOT);
  } catch {
    return created;
  }
  for (const name of entries) {
    const target = name.replace(/\.example\./, ".");
    if (target === name) continue; // not a *.example.* template
    const dest = path.join(ROOT, target);
    if (fs.existsSync(dest)) continue; // never overwrite the user's file
    try {
      fs.copyFileSync(path.join(ROOT, name), dest);
      created.push(target);
    } catch {
      /* best-effort: a read-only FS just falls back to in-memory defaults */
    }
  }
  return created;
}

function loadConfig() {
  const defaults = {
    org: "", // set your GitHub org/user in config.json (see config.example.json)
    host: "127.0.0.1",
    port: 8787,
    workDir: ".work",
    branchPrefix: "dependency-updates/soc2",
    draftPRs: true,
    alertState: "open",
    includeRepos: [],
    excludeRepos: [],
    autoInstallRuby: true,
    autoInstallNode: true,
    autoInstallGo: true,
    autoInstallPhp: true,
    emailHourlyRate: 200,
    npm: { force: false },
    autoFixCI: false, // when true, auto-launch a headless Claude fix on a failing PR
    ciPollSeconds: 90,
    maxConcurrentFixes: 1,
    claudeFix: { permissionMode: "auto", timeoutMinutes: 12, maxAttemptsPerSha: 2, maxAttemptsPerRepo: 4 },
    autoUpgradeEOL: false, // when true, auto-open a runtime-upgrade PR for EOL runtimes
    eolPollHours: 12,
    autoFixGemConstraints: false, // when true, a blocked gem auto-opens a constraint-bump PR
    claudeBump: { permissionMode: "auto", timeoutMinutes: 20 },
    dismissToken: "", // optional dedicated token for the Dismiss-on-GitHub calls only
                      // (fine-grained PAT with "Dependabot alerts: Read and write").
                      // Falls back to env DISMISS_GH_TOKEN, then to gh's normal auth.
    // SOC 2 branch-protection ruleset applied via the Protect-branch action.
    protection: {
      rulesetName: "SOC 2 — protected default branch",
      requiredApprovals: 1,
      dismissStaleReviews: true,
      requireConversationResolution: true,
      blockForcePush: true,
      restrictDeletion: true,
      requireCodeOwnerReview: false,
      allowAdminBypass: false, // strict: even admins must open a reviewed PR
    },
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return {
      ...defaults,
      ...raw,
      npm: { ...defaults.npm, ...(raw.npm || {}) },
      claudeFix: { ...defaults.claudeFix, ...(raw.claudeFix || {}) },
      claudeBump: { ...defaults.claudeBump, ...(raw.claudeBump || {}) },
      protection: { ...defaults.protection, ...(raw.protection || {}) },
    };
  } catch {
    return defaults;
  }
}

// Resolve the optional dedicated token for the Dismiss-on-GitHub calls, in order:
// env DISMISS_GH_TOKEN → gitignored `.dismiss-token` file → config.dismissToken.
// The env var and the untracked file keep the secret OUT of tracked config.json.
function resolveDismissToken() {
  if (process.env.DISMISS_GH_TOKEN) return process.env.DISMISS_GH_TOKEN.trim();
  try {
    const t = fs.readFileSync(path.join(ROOT, ".dismiss-token"), "utf8").trim();
    if (t) return t;
  } catch {
    /* no file */
  }
  return (config.dismissToken || "").trim() || null;
}

// Optional dedicated token for repo DELETION (env DELETE_GH_TOKEN → gitignored
// `.delete-token`). Deleting needs `delete_repo` (classic) / Administration:write
// (fine-grained), which the gh token usually lacks — so a separate, deliberate token,
// kept out of tracked config. Returns null to fall back to gh's normal auth.
function resolveDeleteToken() {
  if (process.env.DELETE_GH_TOKEN) return process.env.DELETE_GH_TOKEN.trim();
  try {
    const t = fs.readFileSync(path.join(ROOT, ".delete-token"), "utf8").trim();
    if (t) return t;
  } catch {
    /* no file */
  }
  return null;
}

// ---- Tiny state -------------------------------------------------------------
let modelCache = null; // last buildModel() result
let protectionCache = null; // { repoName: { protected, via, ourId } } — branch-protection status

// Check branch protection for a given list of {name, nameWithOwner, defaultBranch}
// (concurrency-capped), merging results into protectionCache by repo name. Incremental:
// only re-checks an entry when missing or `force`. Used for both the alert model and
// the (bounded) needs-compliance set, so we never check all 342 repos.
async function checkProtectionFor(repos, force) {
  protectionCache = protectionCache || {};
  const todo = repos.filter((r) => force || !(r.name in protectionCache));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (r) => {
        try {
          protectionCache[r.name] = await protection.checkProtection(r.nameWithOwner, r.defaultBranch, config.protection.rulesetName);
        } catch {
          protectionCache[r.name] = { protected: null };
        }
      })
    );
  }
  return protectionCache;
}

// Branch-protection status for the alert model's repos (the existing per-card badges).
// Computed lazily (the client polls it), so the main scan stays fast.
async function pollProtection(force) {
  if (!modelCache) return protectionCache;
  if (protectionCache && !force) return protectionCache;
  await checkProtectionFor(modelCache.repos.filter((r) => !r.archived), force);
  for (const r of modelCache.repos) if (protectionCache[r.name]) r.protected = protectionCache[r.name].protected;
  return protectionCache;
}

// --- SOC 2 compliance inventory ---------------------------------------------
let orgReposCache = null;
let orgReposAt = 0;
async function getOrgRepos(force) {
  if (orgReposCache && !force && Date.now() - orgReposAt < 5 * 60 * 1000) return orgReposCache;
  orgReposCache = await gh.listOrgRepos(config.org);
  orgReposAt = Date.now();
  return orgReposCache;
}
let archivedReposCache = null;
let archivedReposAt = 0;
async function getArchivedOrgRepos(force) {
  if (archivedReposCache && !force && Date.now() - archivedReposAt < 5 * 60 * 1000) return archivedReposCache;
  archivedReposCache = await gh.listArchivedOrgRepos(config.org);
  archivedReposAt = Date.now();
  return archivedReposCache;
}

const TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000;
function isDormant(pushedAt) {
  return pushedAt ? Date.parse(pushedAt) < Date.now() - TWO_YEARS_MS : false;
}

// Dependency-graph + gem/published enrichment for the inventory. Scoped to the repos
// worth assessing — active (non-dormant) OR in-scope — so it stays a ~60-repo scan,
// not all 342. Computed in the background and cached (1h); the client re-polls to fill
// in the columns. dependents are inverted from the scanned set, so a repo gets credit
// for any active depender even if the repo itself isn't in the scan.
let complianceEnrichCache = null;
let complianceEnrichAt = 0;
let complianceEnrichRunning = false;
async function enrichCompliance(orgRepos, force) {
  if (complianceEnrichCache && !force && Date.now() - complianceEnrichAt < 3600000) return complianceEnrichCache;
  if (complianceEnrichRunning) return complianceEnrichCache;
  complianceEnrichRunning = true;
  try {
    const cls = state.classificationMap();
    const overrides = state.scopeOverrideMap();
    const inScope = (n) => (overrides[n] ? overrides[n].scope === "in" : cls[n] === "maintained");
    const set = orgRepos.filter((r) => !isDormant(r.pushedAt) || inScope(r.name));
    const work = set.map((r) => ({ name: r.name }));
    await gh.enrichComplianceRepos(config.org, work);
    const dependents = {};
    for (const r of work) for (const dep of r.dependsOnOrg || []) (dependents[dep] = dependents[dep] || []).push(r.name);
    const out = {};
    for (const r of work) out[r.name] = { isGem: r.isGem, published: r.published, dependsOnOrg: r.dependsOnOrg };
    for (const name of Object.keys(dependents)) {
      out[name] = out[name] || {};
      out[name].dependents = dependents[name];
    }
    complianceEnrichCache = out;
    complianceEnrichAt = Date.now();
  } finally {
    complianceEnrichRunning = false;
  }
  return complianceEnrichCache;
}

// ---- Background update jobs -------------------------------------------------
// Each "open update PR" is a managed background job. createUpdatePR spawns
// gh/git/bundle/npm as CHILD PROCESSES (real OS-level parallelism — Node's
// single JS thread only orchestrates I/O and never blocks on the heavy work).
// A queue caps how many run at once, and a single global event stream
// (/api/events) fans progress out to the browser — so the UI survives reloads
// and isn't throttled by the browser's ~6-connections-per-host limit.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_UPDATES || config.maxConcurrentUpdates || 3);
const jobs = new Map(); // jobId -> job
const eventClients = new Set(); // attached /api/events response streams
let jobSeq = 0;
let runningCount = 0;

function broadcast(evt) {
  const line = JSON.stringify(evt) + "\n";
  for (const res of eventClients) {
    try {
      res.write(line);
    } catch {
      /* client gone; req 'close' will prune it */
    }
  }
}

function jobEmit(job, type, data) {
  const evt = { jobId: job.id, repo: job.repo, type, ...data };
  job.log.push(evt);
  broadcast(evt);
}

function findActiveJob(repoName) {
  for (const j of jobs.values()) {
    if (j.repo === repoName && (j.status === "queued" || j.status === "running")) return j;
  }
  return null;
}

/** Start (or return the existing) background update job. `upgrade` (optional)
 *  turns it into a runtime-upgrade job that also bumps an EOL runtime pin. */
function startUpdateJob(repoModel, upgrade) {
  const existing = findActiveJob(repoModel.name);
  if (existing) return existing;
  const job = {
    id: `${upgrade ? "upgrade" : "job"}-${++jobSeq}`,
    kind: upgrade ? "upgrade" : "update",
    repo: repoModel.name,
    model: repoModel,
    upgrade: upgrade || null,
    status: "queued",
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    log: [],
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  jobEmit(job, "status", { status: "queued", kind: job.kind });
  jobEmit(job, "log", {
    line: upgrade
      ? `⏳ Queued runtime upgrade — ${upgrade.id} ${upgrade.from} → ${upgrade.to}…`
      : "⏳ Queued — waiting for a free update slot…",
    level: upgrade ? "warn" : "info",
  });
  pumpQueue();
  return job;
}

/** Start a constraint-bump job: a headless Claude session that raises a gem's
 *  blocking gemspec constraints and opens a draft PR. */
function startBumpJob(repoModel, blocked) {
  const existing = findActiveJob(repoModel.name);
  if (existing) return existing;
  const job = {
    id: `bump-${++jobSeq}`,
    kind: "bump",
    repo: repoModel.name,
    model: repoModel,
    blocked: blocked || [],
    status: "queued",
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    log: [],
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  jobEmit(job, "status", { status: "queued", kind: "bump" });
  jobEmit(job, "log", { line: `⏳ Queued constraint bump — raising ${(blocked || []).length} blocking constraint(s)…`, level: "warn" });
  pumpQueue();
  return job;
}

/** A blocked gem (a gemspec constraint caps a dep below its patch) auto-opens a
 *  constraint-bump PR when enabled — the actionable remediation chosen for blocked
 *  gems. Deduped by advisory signature so it never re-fires for the same set. */
function maybeAutoBump(model) {
  if (!config.autoFixGemConstraints) return;
  const d = model.disposition;
  if (!d || d.state !== "blocked") return;
  if (model.pending || findActiveJob(model.name)) return;
  const sig = state.dispositionSig(model.packages);
  if (state.bumpAttempted(model.name, sig)) return;
  state.recordBump(model.name, sig);
  startBumpJob(model, d.blocked || []);
}

/** Promote queued jobs into running while there's free capacity. Fix jobs have
 *  their own queue/pump (pumpFixQueue) — promoting one here would run it through
 *  runJob, which treats it as an update and would open a spurious update PR. */
function pumpQueue() {
  for (const job of jobs.values()) {
    if (runningCount >= MAX_CONCURRENT) break;
    if (job.status === "queued" && job.kind !== "fix") runJob(job);
  }
}

function runJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  runningCount++;
  jobEmit(job, "status", { status: "running", kind: job.kind });
  (async () => {
    try {
      const emit = (type, data) => jobEmit(job, type, { ...data, kind: job.kind });
      const result =
        job.kind === "bump"
          ? await createConstraintBumpPR({ config, repo: job.model, blocked: job.blocked, emit })
          : await createUpdatePR({ config, repo: job.model, emit, upgrade: job.upgrade });
      job.result = result;
      job.status = "done";
      // Reflect a newly-opened PR in the cached model immediately so a reload
      // (which reads the cache) keeps the repo in Pending, independent of
      // GitHub's PR-search index catching up. Merge (don't clobber) so a runtime
      // upgrade PR can coexist with a dependency-update PR.
      if (result && result.prUrl) {
        const num = (result.prUrl.match(/\/pull\/(\d+)/) || [])[1];
        const entry = { number: num ? Number(num) : null, url: result.prUrl, draft: !!config.draftPRs };
        job.model.pending = true;
        job.model.openPRs = job.model.openPRs || [];
        if (!job.model.openPRs.some((p) => p.url === result.prUrl)) job.model.openPRs.push(entry);
      }
      // Persist a gem's verdict (covered | blocked) so the card routes to the Covered
      // tab / constraint-bump flow on the next reload without re-running.
      if (result && result.disposition) {
        const sig = state.dispositionSig(job.model.packages);
        job.model.disposition = state.recordDisposition(job.model.name, { ...result.disposition, sig });
        maybeAutoBump(job.model); // blocked gem → auto-open a constraint-bump PR (if enabled)
      }
    } catch (e) {
      job.error = e.message;
      job.status = "error";
      jobEmit(job, "error", { message: e.message, kind: job.kind });
    } finally {
      job.endedAt = Date.now();
      runningCount--;
      jobEmit(job, "status", { status: job.status, kind: job.kind });
      pruneJobs();
      pumpQueue();
    }
  })();
}

/** Keep only the 50 most recent finished jobs so memory stays bounded. */
function pruneJobs() {
  const finished = [...jobs.values()]
    .filter((j) => j.status === "done" || j.status === "error")
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  while (finished.length > 50) jobs.delete(finished.shift().id);
}

// Heartbeat so idle /api/events connections aren't dropped, and dead ones get pruned.
setInterval(() => broadcast({ type: "ping" }), 25000).unref();

// ---- CI status + autonomous fix jobs ----------------------------------------
// Poll each pending PR's CI. When one is failing (and we're under the per-commit
// attempt cap), launch a headless Claude session to fix it & push — a "fix" job
// that rides the same event stream as update jobs, gated by config.autoFixCI.
const ciStatus = new Map(); // repo -> { state, headSha, failing, checks, at }
let fixRunning = 0;

function activeFixJob(repoName) {
  for (const j of jobs.values()) {
    if (j.kind === "fix" && j.repo === repoName && (j.status === "queued" || j.status === "running")) return j;
  }
  return null;
}

function startFixJob(repoModel, pr, prStatus, failingLogs) {
  const existing = activeFixJob(repoModel.name);
  if (existing) return existing;
  const job = {
    id: `fix-${++jobSeq}`,
    kind: "fix",
    repo: repoModel.name,
    model: repoModel,
    pr,
    branch: pr.headRefName,
    prStatus,
    failingLogs,
    status: "queued",
    queuedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    log: [],
    error: null,
  };
  jobs.set(job.id, job);
  jobEmit(job, "status", { status: "queued", kind: "fix" });
  jobEmit(job, "log", { line: `⏳ Queued CI-fix for PR #${pr.number} — ${prStatus.failing.length} failing check(s)…`, level: "warn" });
  pumpFixQueue();
  return job;
}

function pumpFixQueue() {
  const max = Number(config.maxConcurrentFixes || 1);
  for (const job of jobs.values()) {
    if (fixRunning >= max) break;
    if (job.kind === "fix" && job.status === "queued") runFixJob(job);
  }
}

function runFixJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  fixRunning++;
  // Record the attempt up front so a crash/loop can't re-fire on the same commit.
  state.recordFixAttempt(job.repo, job.prStatus.headSha);
  jobEmit(job, "status", { status: "running", kind: "fix" });
  (async () => {
    try {
      await createFixSession({
        config,
        repo: job.model,
        pr: job.pr,
        branch: job.branch,
        prStatus: job.prStatus,
        failingLogs: job.failingLogs,
        emit: (type, data) => jobEmit(job, type, { ...data, kind: "fix" }),
      });
      job.status = "done";
    } catch (e) {
      job.status = "error";
      jobEmit(job, "error", { message: e.message, kind: "fix" });
    } finally {
      job.endedAt = Date.now();
      fixRunning--;
      jobEmit(job, "status", { status: job.status, kind: "fix" });
      pruneJobs();
      pumpFixQueue();
    }
  })();
}

async function prBranch(nwo, number) {
  const res = await run("gh", ["pr", "view", String(number), "--repo", nwo, "--json", "headRefName", "--jq", ".headRefName"]);
  return res.code === 0 ? res.stdout.trim() : null;
}

const STATE_RANK = { failing: 3, pending: 2, none: 1, unknown: 0, passing: 0 };

async function pollCI() {
  if (!modelCache) return;
  const pending = modelCache.repos.filter((r) => !r.archived && r.pending && (r.openPRs || []).length);
  for (const r of pending) {
    const nwo = `${config.org}/${r.name}`;
    let worst = null; // worst CI state across the repo's PRs → drives the badge
    for (const pr of r.openPRs) {
      if (!pr || !pr.number) continue;
      let st;
      try {
        st = await ci.fetchPRStatus(nwo, pr.number);
      } catch {
        continue;
      }
      // Keep the PR's draft / review state fresh on each poll (not just on a full
      // Refresh) so review requests and draft→ready flips show up live.
      if (st.state !== "unknown") {
        pr.draft = st.isDraft;
        pr.reviewDecision = st.reviewDecision;
        pr.reviewers = st.reviewers || [];
      }
      if (!worst || (STATE_RANK[st.state] || 0) > (STATE_RANK[worst.state] || 0)) worst = st;

      if (
        config.autoFixCI &&
        st.state === "failing" &&
        st.headSha &&
        !activeFixJob(r.name) &&
        state.fixAttemptCount(r.name, st.headSha) < (config.claudeFix.maxAttemptsPerSha || 2) &&
        state.fixTotalForRepo(r.name) < (config.claudeFix.maxAttemptsPerRepo || 4)
      ) {
        const branch = await prBranch(nwo, pr.number);
        if (!branch) continue;
        pr.headRefName = branch;
        const failingLogs = await ci.fetchFailingLogs(nwo, st.failing);
        startFixJob(r, pr, st, failingLogs);
        break; // one fix session per repo at a time
      }
    }
    if (worst) ciStatus.set(r.name, { ...worst, at: Date.now() });
  }
}

// ---- Runtime end-of-life detection + auto-upgrade ---------------------------
const eolStatus = new Map(); // repo -> findings[]

async function pollEol() {
  if (!modelCache) return;
  const inScope = modelCache.repos.filter((r) => !r.archived && r.classification !== "ignored");
  for (const r of inScope) {
    let findings;
    try {
      findings = await eol.checkRepoEol(`${config.org}/${r.name}`, r.ecosystems);
    } catch {
      continue;
    }
    r.runtimeEol = findings;
    if (findings.length) eolStatus.set(r.name, findings);
    else eolStatus.delete(r.name);

    // Auto-open only for repos we actively MAINTAIN (the engagement model's "we
    // patch this"). Monitored/untriaged/ignored EOL repos still get the badge +
    // manual "Propose upgrade" button, just no automatic PR.
    if (config.autoUpgradeEOL && r.classification === "maintained") {
      for (const f of findings) {
        if (state.upgradeAttempted(r.name, f.id, f.target.version)) continue;
        if (findActiveJob(r.name)) break; // a job is already running for this repo
        state.recordUpgrade(r.name, f.id, f.target.version);
        startUpdateJob(r, { id: f.id, ecosystem: f.id, from: f.pinned, to: f.target.version, lts: f.target.lts });
        break; // one upgrade PR per repo per poll
      }
    }
  }
}

let eolPollTimer = null;
function startEolPoller() {
  const ms = Math.max(1, Number(config.eolPollHours || 12)) * 3600 * 1000;
  const tick = () => pollEol().catch(() => {}).finally(() => { eolPollTimer = setTimeout(tick, ms); });
  eolPollTimer = setTimeout(tick, 8000); // first scan shortly after boot
}

let ciPollTimer = null;
function startCIPoller() {
  const ms = Math.max(30, Number(config.ciPollSeconds || 90)) * 1000;
  const tick = () => pollCI().catch(() => {}).finally(() => { ciPollTimer = setTimeout(tick, ms); });
  ciPollTimer = setTimeout(tick, 5000); // first poll shortly after boot
}

// ---- Static files -----------------------------------------------------------
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/index.html": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
};

// ---- Helpers ----------------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Guard mutating endpoints against DNS-rebinding: Host must be loopback. */
function isLocalHost(req) {
  const host = (req.headers.host || "").split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

// ---- Request handling -------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = u.pathname;

  try {
    // Static
    if (req.method === "GET" && STATIC[route]) {
      const [file, type] = STATIC[route];
      const body = fs.readFileSync(path.join(ROOT, file));
      res.writeHead(200, { "Content-Type": type });
      return res.end(body);
    }

    // Health
    if (req.method === "GET" && route === "/api/health") {
      try {
        const login = await gh.whoami();
        return sendJSON(res, 200, { ok: true, login, org: config.org, draftPRs: config.draftPRs });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message, org: config.org });
      }
    }

    // Repos (cached; ?refresh=1 to rebuild)
    if (req.method === "GET" && route === "/api/repos") {
      if (!modelCache || u.searchParams.get("refresh") === "1") {
        modelCache = await gh.buildModel(config);
        pollEol().catch(() => {}); // scan EOL runtimes (+ auto-upgrade) once the model is ready
      }
      return sendJSON(res, 200, modelCache);
    }

    // Global background-job event stream (NDJSON). On connect it replays the
    // buffered events of every still-active job, so a freshly-loaded or reloaded
    // browser re-syncs in-flight progress, then follows live updates.
    if (req.method === "GET" && route === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.write(JSON.stringify({ type: "hello", maxConcurrent: MAX_CONCURRENT }) + "\n");
      for (const job of jobs.values()) {
        if (job.status === "queued" || job.status === "running") {
          for (const evt of job.log) res.write(JSON.stringify(evt) + "\n");
        }
      }
      eventClients.add(res);
      req.on("close", () => eventClients.delete(res));
      return; // keep the connection open
    }

    // Snapshot of jobs (for debugging / non-streaming clients).
    if (req.method === "GET" && route === "/api/jobs") {
      return sendJSON(res, 200, {
        maxConcurrent: MAX_CONCURRENT,
        running: runningCount,
        jobs: [...jobs.values()].map((j) => ({
          id: j.id,
          repo: j.repo,
          status: j.status,
          startedAt: j.startedAt,
          prUrl: (j.result && j.result.prUrl) || null,
        })),
      });
    }

    // CI status for every pending PR (cached; ?refresh=1 forces a poll now).
    if (req.method === "GET" && route === "/api/pr-status") {
      if (u.searchParams.get("refresh") === "1") await pollCI();
      const statuses = {};
      for (const [repo, s] of ciStatus) {
        const perSha = state.fixAttemptCount(repo, s.headSha);
        const capped =
          perSha >= (config.claudeFix.maxAttemptsPerSha || 2) ||
          state.fixTotalForRepo(repo) >= (config.claudeFix.maxAttemptsPerRepo || 4);
        statuses[repo] = {
          state: s.state,
          failing: (s.failing || []).map((f) => f.name),
          headSha: s.headSha,
          attempts: perSha,
          capped,
          fixing: !!activeFixJob(repo),
          at: s.at,
        };
      }
      // Fresh per-PR draft/review state (kept current by pollCI) so the client can update
      // its badges live, without a full model rebuild.
      const prMeta = {};
      if (modelCache) {
        for (const r of modelCache.repos) {
          if (r.pending && (r.openPRs || []).length) {
            prMeta[r.name] = r.openPRs.map((p) => ({ number: p.number, draft: !!p.draft, reviewDecision: p.reviewDecision || null, reviewers: p.reviewers || [] }));
          }
        }
      }
      return sendJSON(res, 200, { autoFixCI: !!config.autoFixCI, statuses, prMeta });
    }

    // Runtime kill-switch for auto-fix (no restart needed).
    if (req.method === "POST" && route === "/api/autofix") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { enabled } = await readBody(req);
      config.autoFixCI = !!enabled;
      console.log(`  CI auto-fix toggled ${config.autoFixCI ? "ON" : "off"} at runtime.`);
      return sendJSON(res, 200, { autoFixCI: config.autoFixCI });
    }

    // Runtime kill-switch for auto-upgrade (no restart needed).
    if (req.method === "POST" && route === "/api/autoupgrade") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { enabled } = await readBody(req);
      config.autoUpgradeEOL = !!enabled;
      console.log(`  EOL auto-upgrade toggled ${config.autoUpgradeEOL ? "ON" : "off"} at runtime.`);
      return sendJSON(res, 200, { autoUpgradeEOL: config.autoUpgradeEOL });
    }

    // Manually launch a CI-fix session for one repo's PR (works regardless of autoFixCI).
    if (req.method === "POST" && route === "/api/fix-ci") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const r = modelCache.repos.find((x) => x.name === repo);
      if (!r || !r.pending || !(r.openPRs || []).length) return sendJSON(res, 404, { error: "No open PR for that repo." });
      const pr = r.openPRs[0];
      const nwo = `${config.org}/${repo}`;
      const st = await ci.fetchPRStatus(nwo, pr.number);
      if (st.state !== "failing") return sendJSON(res, 409, { error: `PR checks are "${st.state}", not failing — nothing to fix.` });
      const branch = await prBranch(nwo, pr.number);
      pr.headRefName = branch;
      const failingLogs = await ci.fetchFailingLogs(nwo, st.failing);
      const job = startFixJob(r, pr, st, failingLogs);
      return sendJSON(res, 200, { jobId: job.id, repo, failing: st.failing.map((f) => f.name) });
    }

    // EOL runtime findings per repo (cached; ?refresh=1 scans now).
    if (req.method === "GET" && route === "/api/eol-status") {
      if (u.searchParams.get("refresh") === "1") await pollEol();
      const out = {};
      for (const [repo, findings] of eolStatus) out[repo] = findings;
      return sendJSON(res, 200, { autoUpgradeEOL: !!config.autoUpgradeEOL, eol: out });
    }

    // Manually open a runtime-upgrade PR for one repo (works regardless of autoUpgradeEOL).
    if (req.method === "POST" && route === "/api/upgrade-runtime") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, id } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const r = modelCache.repos.find((x) => x.name === repo);
      if (!r) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      const findings = eolStatus.get(repo) || r.runtimeEol || [];
      const f = id ? findings.find((x) => x.id === id) : findings[0];
      if (!f) return sendJSON(res, 409, { error: "No end-of-life runtime detected for that repo." });
      state.recordUpgrade(repo, f.id, f.target.version);
      const job = startUpdateJob(r, { id: f.id, ecosystem: f.id, from: f.pinned, to: f.target.version, lts: f.target.lts });
      return sendJSON(res, 200, { jobId: job.id, repo, upgrade: `${f.id} ${f.pinned} → ${f.target.version}` });
    }

    // Dismiss a covered-upstream gem's open Dependabot alerts on GitHub, with a
    // documented reason. The gem's constraints already permit the patches, so the
    // alerts aren't actionable here; this is the auditable SOC 2 close. Reversible.
    if (req.method === "POST" && route === "/api/dismiss-alerts") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, reason, comment } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const r = modelCache.repos.find((x) => x.name === repo);
      if (!r) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      const nwo = r.nameWithOwner;
      // Dismissing needs a token with Dependabot-alerts WRITE (classic: security_events;
      // fine-grained: "Dependabot alerts: Read and write"). gh's normal OAuth token often
      // can't get that scope (org OAuth-app limits / keyring quirks), so allow a dedicated,
      // least-privilege token used ONLY for these dismiss calls. Everything else still uses
      // gh's normal auth. Set it in config.json as "dismissToken" or env DISMISS_GH_TOKEN.
      const dismissTok = resolveDismissToken();
      const ghOpts = dismissTok ? { env: { ...process.env, GH_TOKEN: dismissTok, GITHUB_TOKEN: dismissTok } } : undefined;
      const scopeHint = dismissTok
        ? "The configured dismissToken lacks Dependabot-alerts write. Create a fine-grained PAT with 'Dependabot alerts: Read and write' on the org's repos."
        : "Set a dedicated token: create a fine-grained PAT with 'Dependabot alerts: Read and write', then add it to config.json as \"dismissToken\" (or export DISMISS_GH_TOKEN) and restart. (Or get security_events onto your gh token.)";
      const dismissReason = reason || "not_used";
      const okList = ((r.disposition && r.disposition.ok) || []).join(", ");
      const consumers = (r.dependents || []).join(", ");
      // Full detail for OUR audit record (dismissals.json) — no length limit here.
      const auditNote =
        comment ||
        `Covered downstream: this gem's constraints already permit the patched versions` +
          (okList ? ` (${okList})` : "") +
          `, so any consuming app${consumers ? ` (e.g. ${consumers})` : ""} resolves to patched. ` +
          `Dismissed via the Dependency Dashboard for SOC 2 triage.`;
      // GitHub caps dismissed_comment at 280 chars (HTTP 422 otherwise), so send a
      // concise version — the patched-version list lives in our local record above.
      const ghComment = (
        comment ||
        `Covered downstream: this gem's constraints already permit the patched versions, so ` +
          `consuming apps${consumers ? ` (e.g. ${consumers})` : ""} resolve to patched. ` +
          `Dismissed via the Dependency Dashboard (SOC 2 triage).`
      );
      const dismissComment = ghComment.length > 280 ? ghComment.slice(0, 279) + "…" : ghComment;

      const listed = await run("gh", ["api", `repos/${nwo}/dependabot/alerts?state=open&per_page=100`], ghOpts);
      if (listed.code !== 0) {
        const err = (listed.stderr || listed.stdout || "").slice(0, 300);
        const needsScope = /security_events|Resource not accessible|HTTP 403|must have/i.test(err);
        return sendJSON(res, needsScope ? 412 : 502, {
          error: needsScope ? "Token can't read this repo's Dependabot alerts." : "Couldn't list alerts: " + err,
          needsScope,
          hint: needsScope ? scopeHint : undefined,
        });
      }
      let alerts = [];
      try {
        alerts = JSON.parse(listed.stdout) || [];
      } catch {
        alerts = [];
      }
      const numbers = alerts.map((a) => a.number).filter((n) => Number.isInteger(n));
      let dismissed = 0;
      let failed = 0;
      let needsScope = false;
      let lastErr = "";
      for (const n of numbers) {
        const patch = await run("gh", [
          "api", "--method", "PATCH", `repos/${nwo}/dependabot/alerts/${n}`,
          "-f", "state=dismissed",
          "-f", `dismissed_reason=${dismissReason}`,
          "-f", `dismissed_comment=${dismissComment}`,
        ], ghOpts);
        if (patch.code === 0) dismissed++;
        else {
          failed++;
          lastErr = (patch.stderr || patch.stdout || "").slice(0, 300);
          if (/security_events|Resource not accessible|HTTP 403|must have/i.test(lastErr)) needsScope = true;
        }
        // A permission failure is token-wide, not per-alert — stop after the first
        // so a read-only token returns a clear message fast (no 17 failing PATCHes).
        if (needsScope && dismissed === 0) break;
      }
      if (needsScope && dismissed === 0) {
        return sendJSON(res, 412, {
          needsScope: true,
          hint: scopeHint,
          error: "The token can read alerts but lacks Dependabot-alerts WRITE needed to dismiss them.",
        });
      }
      if (dismissed > 0) {
        state.recordDismissal(repo, { dismissed, total: numbers.length, reason: dismissReason, comment: auditNote, ghComment: dismissComment });
        if (failed === 0) {
          // No open alerts remain → drop the repo from the cache entirely (matches both
          // the client and what a fresh re-scan produces), so a page reload doesn't show
          // a 0-alert "covered" ghost. Also clears the on-disk verdict.
          state.clearDisposition(repo);
          const i = modelCache.repos.indexOf(r);
          if (i >= 0) modelCache.repos.splice(i, 1);
        }
      }
      return sendJSON(res, 200, { repo, dismissed, failed, total: numbers.length, error: failed ? lastErr : null });
    }

    // Manually open a constraint-bump PR for a blocked gem (same flow the auto-bump
    // uses). Re-runs the disposition first if we don't have a blocked verdict cached.
    if (req.method === "POST" && route === "/api/bump-constraints") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const r = modelCache.repos.find((x) => x.name === repo);
      if (!r) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      const d = r.disposition;
      if (!d || d.state !== "blocked") {
        return sendJSON(res, 409, { error: "No blocked-constraint verdict for this repo yet — run an update first so the gem is resolved." });
      }
      const sig = state.dispositionSig(r.packages);
      state.recordBump(repo, sig);
      const job = startBumpJob(r, d.blocked || []);
      return sendJSON(res, 200, { jobId: job.id, repo, blocked: (d.blocked || []).length });
    }

    // Branch-protection status for every in-scope repo (cached; ?refresh=1 re-checks).
    if (req.method === "GET" && route === "/api/protection-status") {
      if (!modelCache) modelCache = await gh.buildModel(config);
      const data = await pollProtection(u.searchParams.get("refresh") === "1");
      return sendJSON(res, 200, { protection: data || {} });
    }

    // Apply (or update) the SOC 2 branch-protection ruleset to one repo's default branch.
    if (req.method === "POST" && route === "/api/protect-branch") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      let r = modelCache.repos.find((x) => x.name === repo);
      if (!r) {
        // Not in the alert model (a maintained repo with no open alerts never enters it).
        // Branch protection applies to it all the same — resolve it from the full org
        // inventory, which still carries nameWithOwner + defaultBranch for the ruleset apply.
        const orgRepos = await getOrgRepos();
        r = orgRepos.find((x) => x.name === repo);
      }
      if (!r) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      try {
        const st = await protection.checkProtection(r.nameWithOwner, r.defaultBranch, config.protection.rulesetName);
        const result = await protection.applyProtection(r.nameWithOwner, config, st.ourId);
        r.protected = true;
        if (protectionCache) protectionCache[repo] = { protected: true, via: "ruleset", ourId: result.id };
        return sendJSON(res, 200, { repo, branch: r.defaultBranch, updated: result.updated, rulesetId: result.id });
      } catch (e) {
        const msg = e.message || "ruleset apply failed";
        const needsAdmin = /Resource not accessible|admin|403|Not Found|404/i.test(msg);
        return sendJSON(res, needsAdmin ? 403 : 502, {
          error: needsAdmin ? `Couldn't apply the ruleset — needs admin on ${repo}. ${msg}` : msg,
        });
      }
    }

    // Full SOC 2 compliance inventory: every non-archived org repo, its scope DERIVED from
    // engagement (maintained/pending = in, else out) with any per-repo override applied,
    // and branch-protection status for the in-scope, controlled ones.
    if (req.method === "GET" && route === "/api/compliance") {
      const force = u.searchParams.get("refresh") === "1";
      const orgRepos = await getOrgRepos(force);
      const archivedRepos = await getArchivedOrgRepos(force); // listed separately for audit
      const cls = state.classificationMap();
      const overrides = state.scopeOverrideMap();
      const pendingSet = new Set((modelCache ? modelCache.repos : []).filter((r) => r.pending).map((r) => r.name));
      // SOC 2 scope is DERIVED from engagement: a repo we actively maintain (or have an open
      // tool PR for) is inside our audit boundary; everything else is out. A per-repo
      // override records the rare exception (e.g. an internal/OSS gem you maintain but that
      // sits outside the customer boundary), and takes precedence over the derived value.
      const derivedScope = (name) => (cls[name] === "maintained" || pendingSet.has(name) ? "in" : "out");
      const effectiveScope = (name) => (overrides[name] ? overrides[name].scope : derivedScope(name));
      // Branch protection is the SOC 2 change-management control — required only on repos
      // that are IN scope AND we control (maintained / pending). So overriding a maintained
      // repo to "out" removes its protection requirement; that's the override's real teeth.
      const inProtScope = (name) => effectiveScope(name) === "in" && (cls[name] === "maintained" || pendingSet.has(name));
      const needs = orgRepos.filter((r) => inProtScope(r.name));
      // Don't block the inventory on per-repo protection checks — kick them off in the
      // background; the client re-polls to fill the badges in.
      checkProtectionFor(needs, force).catch(() => {});
      const protectionPending = needs.some((r) => !(protectionCache && r.name in protectionCache));
      // Dependency-graph + gem/published enrichment (background; client re-polls).
      enrichCompliance(orgRepos, force).catch(() => {});
      const enrich = complianceEnrichCache || {};
      const enrichPending = !complianceEnrichCache;
      const engMap = state.latestEngagementMap();
      const repos = orgRepos.map((r) => {
        const protScope = inProtScope(r.name);
        const prot = protScope && protectionCache && protectionCache[r.name] ? protectionCache[r.name].protected : null;
        const e = enrich[r.name] || {};
        return {
          name: r.name,
          url: r.url,
          defaultBranch: r.defaultBranch,
          pushedAt: r.pushedAt,
          visibility: r.visibility,
          scope: effectiveScope(r.name),
          scopeDerived: derivedScope(r.name),
          scopeOverride: overrides[r.name] || null,
          classification: cls[r.name] || "untriaged",
          protectionScope: protScope,
          protected: prot,
          isGem: !!e.isGem,
          published: e.published || null,
          dependents: e.dependents || [],
          engagement: engMap[r.name] || null,
        };
      });
      const by = (f) => repos.filter(f).length;
      const summary = {
        total: repos.length,
        inScope: by((x) => x.scope === "in"),
        outScope: by((x) => x.scope === "out"),
        overridden: by((x) => x.scopeOverride),
        unprotected: by((x) => x.protectionScope && x.protected === false),
      };
      const archived = archivedRepos.map((r) => ({ name: r.name, url: r.url, pushedAt: r.pushedAt, visibility: r.visibility }));
      return sendJSON(res, 200, { repos, summary, archived, protectionPending, enrichPending });
    }

    // Set one repo's compliance decision.
    // Override a repo's DERIVED SOC 2 scope (the rare exception). scope "in"/"out" forces
    // the value; null/"" clears it back to the engagement-derived default. Either way the
    // decision is recorded in the engagement audit trail (kind: "scope").
    if (req.method === "POST" && route === "/api/scope-override") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, scope, reason } = await readBody(req);
      gh.assertRepoName(repo);
      const cls = state.classificationMap();
      const pendingSet = new Set((modelCache ? modelCache.repos : []).filter((r) => r.pending).map((r) => r.name));
      const derived = cls[repo] === "maintained" || pendingSet.has(repo) ? "in" : "out";
      const entry = state.setScopeOverride(repo, scope || null, reason);
      const effective = entry ? entry.scope : derived;
      state.appendEngagement(repo, {
        at: new Date().toISOString(),
        kind: "scope",
        from: derived,
        to: effective,
        note: (reason || "").toString().trim() || (entry ? null : "cleared override — scope follows engagement"),
        sowEndDate: null,
      });
      return sendJSON(res, 200, { repo, scope: effective, override: entry, derived });
    }

    // Client email (fetches the repo's lockfile to classify major/minor/patch)
    if (req.method === "GET" && route === "/api/email") {
      const repo = u.searchParams.get("repo");
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const repoModel = modelCache.repos.find((x) => x.name === repo);
      if (!repoModel) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      const installed = await gh.fetchInstalledVersions(config.org, repo);
      const settings = settingsStore.load();
      const mo = u.searchParams.get("mode"); // one-off override of the configured mode
      const emailCfg = mo === "mailto" || mo === "copy" ? { ...settings.email, mode: mo } : settings.email;
      const email = buildClientEmail(repoModel, installed, {
        estimate: settings.estimate,
        signature: settingsStore.selectedSignature(settings),
        contact: repoModel.contact,
        email: emailCfg,
      });
      return sendJSON(res, 200, email);
    }

    // Settings (TOML-backed): estimate knobs + email signatures
    if (req.method === "GET" && route === "/api/settings") {
      return sendJSON(res, 200, settingsStore.load());
    }
    if (req.method === "POST" && route === "/api/settings") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const body = await readBody(req);
      const saved = settingsStore.save(body);
      return sendJSON(res, 200, saved);
    }

    // Archive (mutating)
    if (req.method === "POST" && route === "/api/archive") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      const result = await gh.archiveRepo(config.org, repo);
      // reflect in caches: alert model + the compliance inventory (archived repos
      // drop out of listOrgRepos, so prune them so a reload doesn't re-show them).
      if (modelCache) {
        const r = modelCache.repos.find((x) => x.name === repo);
        if (r) r.archived = true;
      }
      if (orgReposCache) orgReposCache = orgReposCache.filter((r) => r.name !== repo);
      if (complianceEnrichCache) delete complianceEnrichCache[repo];
      if (archivedReposCache) archivedReposCache.push({ name: repo, url: `https://github.com/${config.org}/${repo}`, pushedAt: new Date().toISOString(), visibility: "private" });
      return sendJSON(res, 200, result);
    }

    // Unarchive (mutating) — bring an archived repo back into the active inventory.
    if (req.method === "POST" && route === "/api/unarchive") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      const result = await gh.unarchiveRepo(config.org, repo);
      if (archivedReposCache) archivedReposCache = archivedReposCache.filter((r) => r.name !== repo);
      orgReposAt = 0; // force the active inventory to re-fetch (the repo is active again)
      return sendJSON(res, 200, result);
    }

    // Permanently DELETE a repo on GitHub (irreversible). Guarded: requires a typed
    // confirmation matching the repo name, and a token with delete permission (your gh
    // token usually can't — that's a fail-safe, not a bug).
    if (req.method === "POST" && route === "/api/delete-repo") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, confirm } = await readBody(req);
      gh.assertRepoName(repo);
      if (confirm !== repo) return sendJSON(res, 400, { error: "Confirmation text must exactly match the repo name." });
      const tok = resolveDeleteToken();
      const opts = tok ? { env: { ...process.env, GH_TOKEN: tok, GITHUB_TOKEN: tok } } : undefined;
      const del = await run("gh", ["repo", "delete", `${config.org}/${repo}`, "--yes"], opts);
      if (del.code !== 0) {
        const err = (del.stderr || del.stdout || "").slice(0, 400);
        const needsScope = /delete_repo|must have admin|insufficient|HTTP 403|Resource not accessible|scope/i.test(err);
        return sendJSON(res, needsScope ? 412 : 502, {
          needsScope,
          error: needsScope
            ? "The token can't delete repos. Create a PAT with delete permission (classic: the `delete_repo` scope; fine-grained: Administration → Read and write) and drop it in a git-ignored `.delete-token` file (or set DELETE_GH_TOKEN). Your gh token lacks it by design."
            : "Delete failed: " + err,
        });
      }
      // Purge from every cache so it vanishes everywhere.
      if (orgReposCache) orgReposCache = orgReposCache.filter((r) => r.name !== repo);
      if (complianceEnrichCache) delete complianceEnrichCache[repo];
      if (protectionCache) delete protectionCache[repo];
      if (modelCache) modelCache.repos = modelCache.repos.filter((r) => r.name !== repo);
      state.setCompliance(repo, null);
      return sendJSON(res, 200, { repo, deleted: true });
    }

    // Classify a repo's engagement: maintained | monitored | ignored, or
    // null/omitted to clear back to untriaged. Persisted to classifications.json.
    if (req.method === "POST" && route === "/api/classify") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, state: want, note, sowEndDate } = await readBody(req);
      gh.assertRepoName(repo);
      const from = state.classificationMap()[repo] || "untriaged";
      const applied = state.setClassification(repo, want);
      const to = applied || "untriaged";
      let entry = null;
      // Record the transition in the audit log on any actual change (every change is
      // noted — that's the SOC 2 trail of when/why our responsibility shifted).
      if (from !== to) {
        entry = state.appendEngagement(repo, {
          at: new Date().toISOString(),
          kind: "engagement",
          from,
          to,
          note: (note || "").toString().trim() || null,
          sowEndDate: sowEndDate || null,
        });
      }
      if (modelCache) {
        const r = modelCache.repos.find((x) => x.name === repo);
        if (r) { r.classification = to; r.engagement = entry || r.engagement; }
      }
      return sendJSON(res, 200, { repo, state: to, engagement: entry });
    }

    // Full engagement history for one repo (the audit trail of classification changes).
    if (req.method === "GET" && route === "/api/engagement-log") {
      const repo = u.searchParams.get("repo") || "";
      if (!repo) return sendJSON(res, 400, { error: "repo required" });
      return sendJSON(res, 200, { repo, log: state.engagementLogFor(repo) });
    }

    // Per-repo client contact (name + email)
    if (req.method === "POST" && route === "/api/contact") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, name, email } = await readBody(req);
      gh.assertRepoName(repo);
      const saved = state.setContact(repo, { name, email });
      if (modelCache) {
        const r = modelCache.repos.find((x) => x.name === repo);
        if (r) r.contact = saved;
      }
      return sendJSON(res, 200, { repo, contact: saved });
    }

    // Notify toggle: record (or clear) that we've emailed the client about this
    // repo, snapshotting the advisories we cited.
    if (req.method === "POST" && route === "/api/notify") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo, clear } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const r = modelCache.repos.find((x) => x.name === repo);
      if (!r) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      if (clear) {
        state.clearNotified(repo);
        r.notifiedAt = null;
        r.newAdvisoryCount = 0;
        return sendJSON(res, 200, { repo, notifiedAt: null });
      }
      const ghsas = [...new Set((r.packages || []).map((p) => p.ghsa).filter(Boolean))];
      const rec = state.setNotified(repo, ghsas);
      r.notifiedAt = rec.notifiedAt;
      r.newAdvisoryCount = 0; // just snapshotted, nothing new yet
      return sendJSON(res, 200, { repo, notifiedAt: rec.notifiedAt });
    }

    // Start a background update-PR job for one repo. Returns immediately with a
    // job id; progress arrives over /api/events. (No long-lived request stream,
    // so kicking off many at once doesn't exhaust the browser's connection pool.)
    if (req.method === "POST" && route === "/api/update-pr") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const { repo } = await readBody(req);
      gh.assertRepoName(repo);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const repoModel = modelCache.repos.find((x) => x.name === repo);
      if (!repoModel) return sendJSON(res, 404, { error: `Unknown repo: ${repo}` });
      const job = startUpdateJob(repoModel);
      return sendJSON(res, 200, { jobId: job.id, repo, status: job.status });
    }

    // Start background update-PR jobs for many repos at once ("Fix All"). The
    // queue caps how many actually run concurrently; the rest wait their turn.
    if (req.method === "POST" && route === "/api/update-all") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const body = await readBody(req);
      if (!modelCache) modelCache = await gh.buildModel(config);
      const names = Array.isArray(body.repos) ? body.repos : [];
      const started = [];
      const skipped = [];
      for (const name of names) {
        try {
          gh.assertRepoName(name);
        } catch {
          skipped.push({ repo: name, reason: "invalid name" });
          continue;
        }
        const m = modelCache.repos.find((x) => x.name === name);
        if (!m) {
          skipped.push({ repo: name, reason: "unknown" });
          continue;
        }
        if (m.archived || m.pending) {
          skipped.push({ repo: name, reason: m.archived ? "archived" : "already has a PR" });
          continue;
        }
        const job = startUpdateJob(m);
        started.push({ repo: name, jobId: job.id, status: job.status });
      }
      return sendJSON(res, 200, { started, skipped, maxConcurrent: MAX_CONCURRENT });
    }

    // Open a batch of GitHub URLs as new tabs in the OS default browser. Done
    // server-side (via `open`/`xdg-open`) because a browser would popup-block a
    // loop of window.open() calls. URLs are validated to github.com only.
    if (req.method === "POST" && route === "/api/open-urls") {
      if (!isLocalHost(req)) return sendJSON(res, 403, { error: "non-local host" });
      const body = await readBody(req);
      const urls = (Array.isArray(body.urls) ? body.urls : []).filter(
        (u) => typeof u === "string" && /^https:\/\/github\.com\/[A-Za-z0-9._\-/]+$/.test(u)
      );
      if (!urls.length) return sendJSON(res, 400, { error: "no valid github.com URLs" });
      try {
        if (process.platform === "darwin") {
          await run("open", urls); // `open` takes multiple URLs → tabs in the default browser
        } else if (process.platform === "win32") {
          for (const u of urls) await run("cmd", ["/c", "start", "", u]);
        } else {
          for (const u of urls) await run("xdg-open", [u]);
        }
        return sendJSON(res, 200, { opened: urls.length });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Dependency Dashboard`);
  console.log(`  ────────────────────────────`);
  if (createdLocalFiles.length) {
    console.log(`  First run: created ${createdLocalFiles.length} local file(s) from templates (config + state).`);
  }
  console.log(`  Org:    ${config.org || "(unset — edit config.json: \"org\": \"your-github-org\")"}`);
  console.log(`  Serving ${url}  (bound to ${HOST} only)`);
  console.log(`  PRs:    ${config.draftPRs ? "draft" : "ready"} by default\n`);
  console.log(`  Open ${url} in your browser. Ctrl+C to stop.\n`);
  console.log(`  CI auto-fix: ${config.autoFixCI ? "ON" : "off"} (poll ${config.ciPollSeconds}s, mode ${config.claudeFix.permissionMode})\n`);
  console.log(`  EOL auto-upgrade: ${config.autoUpgradeEOL ? "ON" : "off"} (scan every ${config.eolPollHours}h)\n`);
  console.log(`  Gem constraint auto-bump: ${config.autoFixGemConstraints ? "ON" : "off"} (blocked gems → constraint-bump PR)\n`);
  startCIPoller();
  startEolPoller();
});
