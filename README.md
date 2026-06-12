# Dependency Dashboard

A **local** triage dashboard for Dependabot security alerts across the
`your-org` GitHub org. It runs on your own `gh` CLI authentication — nothing
hosted, nothing exposed to the internet, and no tokens to manage for the core
workflow. (One optional, least-privilege token unlocks GitHub-native alert
dismissal — see [Credentials & local setup](#credentials--local-setup).)

For each repository with open alerts it shows the severity breakdown and the exact
flagged packages, sorts it into a **triage tab** by how you've classified the repo
(and what kind of project it is), and offers the remediation that fits:

- **Archive repo** — for dead/POC repos. Archives it on GitHub (read-only) so it
  drops out of the active SOC 2 audit scope. Reversible from repo settings.
- **Create update PR** — clones, branches, runs **lockfile-only** dependency
  updates targeting the flagged packages, pushes, and opens a **draft** PR; CI on
  the PR is the validation gate. **⚡ Open update PRs for all** fans this out across
  every eligible repo as background jobs.
- **Propose upgrade** — when a repo pins an **end-of-life** Ruby/Node/Go/PHP,
  rewrites the version pin and opens a runtime-upgrade PR.
- **Dismiss on GitHub** / **Open constraint-bump PR** — the two fixes for a **gem**
  (library), depending on whether its gemspec constraints already permit the
  patches or block one.
- **Email client / Mark notified** — for inactive-client repos you only monitor:
  generate a plain-English notice with an effort estimate.
- **Protect branch / Compliance inventory** — enforce a SOC 2 branch-protection
  ruleset (reviewed PRs, no force-push) on a repo's default branch, and record an
  explicit in/out-of-scope decision for **every** org repo in the **Compliance** tab.
  See [Branch protection & the compliance inventory](#branch-protection--the-compliance-inventory).

Three loops can also run unattended (all opt-in): a **CI auto-fix** that drives a
headless Claude session to green a failing update PR, **EOL auto-upgrade**, and a
**gem constraint-bump**. See [Autonomous loops](#autonomous-loops). A visual map of
every trigger and the shared pipeline is in
[`docs/update-flow.md`](docs/update-flow.md).

> Why local instead of a hosted dashboard? Your unpatched-CVE list is sensitive.
> GitHub Pages on the Team plan has no auth, and the built-in org Security
> Overview UI requires Enterprise. Running locally on your `gh` auth keeps the
> data behind GitHub's own access controls and adds zero infrastructure.

## Prerequisites

- **Node.js ≥ 18** (`node -v`)
- **GitHub CLI** authenticated: `gh auth status` (needs `repo` + `read:org` scope —
  your current token already has them)
- **git**
- **Claude Code CLI** (`claude` on your PATH) — only for the autonomous loops: the
  CI auto-fix and gem constraint-bump spawn a headless `claude` session. Nothing
  else needs it.
- For the update PRs to actually change files, the relevant toolchain must be on
  your PATH: `npm`/`pnpm` for JS, `bundle` (or `mise`) for Ruby, `composer`,
  `go`. Missing tools are skipped with a note in the run log — nothing breaks.

## Credentials & local setup

Everything runs on **your own GitHub credentials** — nothing is hosted, and only
your loopback interface is bound.

### 1. GitHub CLI — required (the main auth)

The dashboard shells out to `gh` for every read and write (listing alerts,
cloning, opening and checking PRs). Authenticate once:

```bash
gh auth login          # github.com → pick your git protocol (SSH or HTTPS)
gh auth status         # verify — the token needs `repo` + `read:org`
```

`gh auth login`'s default scopes already include `repo` and `read:org`, which is
everything the core workflow needs. Git pushes use your normal git auth (SSH key
or gh's credential helper), independent of the API token's scopes.

### 2. Dismiss-on-GitHub token — optional (only for dismissing "covered" gems)

The **✓ Dismiss on GitHub** button (on the **Covered** tab) marks a gem's
non-actionable Dependabot alerts as `dismissed` with a documented reason. That
one action needs **Dependabot-alerts _write_**, and the GitHub CLI OAuth app
usually **cannot grant it** — its login tops out at a fixed scope set and silently
won't add `security_events`, no matter how many times you run
`gh auth refresh -s security_events` (this is an app/account limitation, *not* an
org setting you can toggle — verify on your
[Authorized OAuth Apps](https://github.com/settings/applications) page: if every
org shows ✓ and the scope still never appears, no owner setting will add it).

So the dashboard uses a **dedicated, least-privilege token for just the dismiss
calls**; everything else keeps using your normal `gh` auth.

> **It's optional.** Without it, the Covered tab still records each disposition
> (rationale + downstream consumer + timestamp) as a local audit trail in
> `dismissals.json`/`dispositions.json` — you just don't get the GitHub-native
> dismissal. Set this up only if you want the alerts to leave GitHub's open set.

**Create a fine-grained PAT (recommended — least privilege):**

1. <https://github.com/settings/personal-access-tokens/new>
2. **Resource owner:** the org you audit (e.g. `your-org`) — approve it yourself if you're an org owner and it's held for approval
3. **Repository access:** All repositories (or just the gems you'll dismiss)
4. **Permissions → Repository → Dependabot alerts → _Read and write_** (only this one)
5. Generate and copy the `github_pat_…`

**Give it to the dashboard without committing a secret.** It's resolved in this
order: `DISMISS_GH_TOKEN` env var → a git-ignored `.dismiss-token` file →
`config.json`:

```bash
# preferred: a git-ignored file at the repo root (never committed)
echo 'github_pat_xxxxxxxx' > .dismiss-token

# …or an env var for the session
DISMISS_GH_TOKEN=github_pat_xxxxxxxx npm start
```

> 💡 Prefer `.dismiss-token` (or the env var) over `config.json`: it's git-ignored
> and read fresh on each dismiss request, so the token never lands in your config
> and takes effect without a restart. (`config.json` is git-ignored too — see
> [Run it](#run-it) — but a dedicated token file keeps secrets out of it entirely.)

The server reads the token fresh on each dismiss request, so dropping the file in
takes effect **without a restart**.

**Classic PAT alternative:** a token from <https://github.com/settings/tokens/new>
with the **`repo`** + **`security_events`** scopes works too (same `.dismiss-token`
file) — quicker to create, but broader than the fine-grained option.

**Verify it (reversible — dismisses one alert, then reopens it):**

```bash
TOK="$(tr -d '[:space:]' < .dismiss-token)"; R=your-org/<a-gem>; N=<an-open-alert-#>
GH_TOKEN="$TOK" gh api --method PATCH repos/$R/dependabot/alerts/$N \
  -f state=dismissed -f dismissed_reason=not_used -f dismissed_comment='write test' --jq .state
GH_TOKEN="$TOK" gh api --method PATCH repos/$R/dependabot/alerts/$N -f state=open --jq .state
```

Expect `dismissed` then `open`. A **403** means the token lacks write (set the
fine-grained permission to _Read and write_). An **HTTP 422** about
`dismissed_comment` length actually confirms **write works** — the dashboard caps
the comment at GitHub's 280-char limit for you.

## Run it

```bash
cd dependency-dashboard
npm start              # node --watch: auto-restarts when server.js / lib/*.js change
# npm run start:once   # plain node, no file watching
```

On **first start** the app creates your local, git-ignored config + state files from
the `*.example` templates — `config.json`, `settings.toml`, and the per-repo state
files (contacts, classifications, dismissals, compliance, …) — so nothing of yours is
ever committed. Existing files are never overwritten. Then set your org in the freshly
created `config.json` (`"org": "your-github-org"`) and press **Refresh**.

Then open <http://127.0.0.1:8787>. Press **Refresh** to re-scan GitHub. Client files
(`public/*`) are served live, so a browser reload picks those up without a restart;
the watcher only needs to restart for server-side changes. (A watch-restart ends any
in-flight background job, so avoid editing server code mid-run.)

## How it's organized — tabs & triage

Every repo with open alerts lands in exactly one **tab**. You classify each repo
once — *maintained*, *monitored*, or *ignored* — and that choice (persisted to
`classifications.json`; an unclassified repo is *untriaged*) decides where it rests
and which actions it gets. Classification is purely local triage: unlike
**Archive**, it changes nothing on GitHub.

| Tab | What lands here |
| --- | --- |
| **Untriaged** | Not yet classified — the triage inbox. Hidden when empty. |
| **Maintained** | Active client / we host — repos we actually patch. |
| **Pending PR** | Has an open tool-opened PR awaiting merge. Takes precedence over every other tab, whatever the classification. |
| **Covered** | A maintained **gem** whose constraints already permit every patch — no action needed. Hidden when empty. |
| **Monitored** | Inactive client we watch but don't patch — we notify them instead. |
| **Notified** | A monitored repo whose client we've emailed, with no new advisories since. |
| **Ignored** | Out of scope for this tool. |
| **🛡 Compliance** | A *separate* full-org inventory — **every** non-archived repo, not just alerted ones — for the SOC 2 scope decision + branch protection. See [below](#branch-protection--the-compliance-inventory). |

Archived repos drop out of GitHub's alert feed entirely, so there's no archived
tab. The headline **"to maintain"** count is Maintained + Pending — covered gems
and everything monitored/ignored are excluded. Triage buttons sit on each card in
the **Untriaged** tab; elsewhere they move into a per-card menu. Marking a
*monitored* repo notified moves it Monitored → Notified, and a **new** advisory
appearing afterward sends it back to Monitored.

## What each action does, precisely

### Archive
`PATCH /repos/your-org/<repo>` with `archived=true`, after an in-browser
confirm. Unarchive anytime in the repo's GitHub settings.

### Create update PR
1. `gh repo clone your-org/<repo>` (shallow) into `./.work/<repo>`
2. `git switch -C dependency-updates/soc2-YYYY-MM-DD`
3. Lockfile-only updates for the flagged packages:
   - **npm** → `npm audit fix --package-lock-only`
   - **pnpm** → `pnpm update <pkgs> --lockfile-only`
   - **Bundler** → `bundle lock --update <gems>`, run under the repo's **pinned
     Ruby** (from `.ruby-version`/`.mise.toml`/`Gemfile`). It invokes that exact
     mise-installed Ruby's `bundle` binary directly. If the pinned Ruby isn't
     installed it **skips with instructions** (`mise install ruby@X`) rather than
     degrading to macOS system Ruby — see Troubleshooting.
   - **Composer** → `composer update <pkgs> --no-install`
   - **Go** → `go get <mod>@latest` + `go mod tidy`
   - **yarn** → Yarn Berry (≥2): `yarn up <pkgs> --mode=update-lockfile`. Yarn
     classic (1.x): noted for manual handling (use `resolutions` / upgrade the
     parent), since transitive dev-deps can't be safely lockfile-bumped in 1.x.
4. If nothing changed, it stops and tells you (no empty PR)
5. Otherwise commit → `git push --force-with-lease` → `gh pr create --draft`

The PR body lists every advisory it targeted and reminds reviewers to let CI run
before merging. The branch is per-day; a same-day re-run refreshes it.

**npm-ecosystem overrides fallback.** Most npm/pnpm/yarn advisories are on
*transitive* dependencies a targeted `update` can't move (a parent's version range
pins them below the patch), so the gentle update produces no lockfile change. When
that happens, the tool writes `overrides` (npm) / `pnpm.overrides` (pnpm) /
`resolutions` (yarn) pinning each flagged package to `>=patched <nextMajor` and
regenerates the lockfile — reaching transitive deps a normal update can't. A forced
bump can break a dependent, so it opens as a **draft** for CI (and the auto-fix loop)
to validate.

### Open update PRs for all (background jobs)
**⚡ Open update PRs for all N** (atop the Untriaged and Maintained tabs) starts a
**Create update PR** job for every eligible repo at once (`POST /api/update-all`;
it skips archived repos and any that already have a PR).

Every update, runtime-upgrade, and constraint-bump runs as a **managed background
job**, not a blocking request:

- A **queue caps concurrency at 3** (`maxConcurrentUpdates`, or env
  `MAX_CONCURRENT_UPDATES`); the rest wait their turn. Each job spawns
  `gh`/`git`/`bundle`/`npm` as child processes, so it's real OS-level parallelism.
- Progress for **all** jobs fans out over **one `/api/events` NDJSON stream** (not a
  connection per job, which would hit the browser's ~6-per-host limit). On connect
  the server **replays the buffered events of every still-active job**, so a tab
  switch — or a full page reload — re-syncs in-flight progress and the live logs
  keep streaming. A repo graduates to **Pending PR** the moment its PR opens.

CI-fix jobs run on a **separate** small pool (`maxConcurrentFixes`, default 1) so an
auto-fix never crowds out the update queue. (See `startUpdateJob`/`runJob`/`pumpQueue`
in `server.js`, and the `JOBS` map in `public/app.js`.)

### Propose upgrade (end-of-life runtimes)
A poller (`lib/eol.js`, on each scan and every `eolPollHours`) reads each in-scope
repo's runtime pin — `.ruby-version`, `.node-version`/`.nvmrc`, `go.mod`,
`.php-version`/`composer.json`, … — and checks it against
[endoflife.date](https://endoflife.date). If the pinned **Ruby / Node / Go / PHP**
is past end-of-life, the card shows a **⚠ EOL badge** with the recommended target
(the oldest still-supported release, preferring an LTS line) and a **⬆ Propose
upgrade** button.

Clicking it (`POST /api/upgrade-runtime`) opens a runtime-upgrade job: it rewrites
every version-pin file off the EOL version (`writePins`), provisions the new runtime
via `mise`, regenerates lockfiles under it, and opens a **draft** PR titled
`⚠ chore(runtime): upgrade …` on a `runtime-upgrade/…` branch. A runtime bump is
usually breaking — it's a draft on purpose, and with CI auto-fix on it flows
straight into that loop.

### Dismiss on GitHub / Open constraint-bump PR (gem dispositions)
An **app** commits a lockfile, so a lockfile-only bump patches it directly. A
**library (gem)** doesn't — consuming apps resolve versions from the gem's *gemspec
constraints*. So when **Create update PR** runs on a Ruby project that has a
`.gemspec` and no committed `Gemfile.lock`, it resolves a throwaway lockfile only to
read off a **disposition** (cached in `dispositions.json`, fingerprinted to the
flagged-advisory set so it self-invalidates when the alerts change):

- **Covered** — the gemspec constraints *already* admit every patched version.
  Nothing to change in the gem; the fix lands in each consuming app (which the
  dashboard patches separately, as an app). The repo rests in the **Covered** tab,
  and its non-actionable alerts can be closed on GitHub with **✓ Dismiss on GitHub**
  (`POST /api/dismiss-alerts`) — a documented, reversible dismissal that also writes
  a local SOC 2 record to `dismissals.json`. This is the one action that needs the
  optional dismiss token (see [Credentials & local setup](#credentials--local-setup)).
- **Blocked** — a gemspec constraint caps a dependency *below* its patched version,
  holding every consuming app on the vulnerable release. The real fix is to raise the
  constraint and cut a release, so the card offers **⛔ Open constraint-bump PR**
  (`POST /api/bump-constraints`): a headless Claude session (`lib/bumper.js`) raises
  the blocking gemspec/`Gemfile` constraints, fixes whatever the wider version
  breaks, commits, and opens a **draft** PR on a `gemspec-bump/…` branch — which then
  flows into the CI auto-fix loop.

### Email client & Mark notified (monitored repos)
For a **monitored** (inactive-client) repo, **✉ Email client** / **⧉ Copy email**
(`lib/email.js`) generates a client-facing notice: each flagged package in plain
English, the severity breakdown, and an **effort/cost estimate** derived from the
real major/minor/patch split (installed → patched), priced at the hourly rate and
hour-weights from the Settings panel (`settings.toml`). It either opens a `mailto:`
draft (with the body copied to paste in) or assembles the whole email to the
clipboard, per the configured mode; a per-repo client **contact** (`contacts.json`)
auto-fills the greeting and recipient.

**Mark notified** records the date and snapshots the advisories you cited
(`notifications.json`), moving the repo to **Notified**. If a **new** advisory
appears later, the card flips to *"N new advisories since you notified — re-notify
recommended"* and the repo returns to **Monitored**.

## Autonomous loops

Three loops can run **unattended**. All ship **off in code** and are turned on by your
`config.json`; each is independent, capped, and safe to flip off (two have
a runtime kill-switch that needs no restart). The two Claude-driven loops spawn a
**headless `claude` session** (`claude -p --permission-mode auto`, streamed as JSON)
that edits the checkout, commits, and pushes.

### CI auto-fix — `autoFixCI`
A poller (`lib/ci.js`, every `ciPollSeconds`) reads each pending PR's checks. On a
**failure**, and only under the attempt caps, it launches a headless Claude session
(`lib/fixer.js`) with the failing jobs' logs; Claude edits the PR branch, commits a
minimal fix, and **pushes so CI re-runs**. The attempt is recorded *before* it runs
(`fix-attempts.json`, keyed `repo@sha`) so a crash or a still-red fix can't loop
forever: capped at **2 attempts per commit** (`claudeFix.maxAttemptsPerSha`) and
**4 per repo** (`claudeFix.maxAttemptsPerRepo`). Toggle it live with the **Auto-fix
CI** button (`POST /api/autofix`); start one by hand any time with **Fix CI now**
(`POST /api/fix-ci`), which works regardless of the toggle.

### EOL auto-upgrade — `autoUpgradeEOL`
When an end-of-life runtime turns up on a **maintained** repo, the runtime-upgrade PR
above opens **automatically** (deduped per repo + runtime + target version in
`upgrade-attempts.json`). Monitored/untriaged/ignored EOL repos still get the badge
and the manual button — just no automatic PR. Live kill-switch: `POST /api/autoupgrade`.

### Gem constraint auto-bump — `autoFixGemConstraints`
When a gem resolves to **blocked**, the constraint-bump PR above opens automatically
(deduped by advisory signature in `bump-attempts.json`), then rides the CI auto-fix
loop to green the breaking upgrade.

## Branch protection & the compliance inventory

SOC 2 change-management (CC8.1) wants every in-scope repo's default branch protected —
no merge without review — plus an auditable record of *which* repos are in scope. Two
features cover that.

### Protect branch (rulesets)
Any repo whose default branch has **no** protection shows a **🔓 unprotected** banner
and a **🛡 Protect branch** button (`POST /api/protect-branch`; a **🛡 Protect all
unprotected N** bar batches it). It applies a GitHub **ruleset** (`config.protection`)
to `~DEFAULT_BRANCH` — one ruleset covers `main` *or* `master` — that requires a PR with
**1 approval**, dismisses stale approvals, requires conversation resolution, and
**blocks force-pushes & deletion**, with **no bypass**. It's **idempotent** (updates the
ruleset in place by name) and **reversible** (repo Settings → Rules). No extra token:
ruleset writes use your `repo` scope + repo-admin (org owner). Status checks and signed
commits are deliberately left out of the *uniform* ruleset (required check names differ
per repo; signing is high-friction) — adjust the policy in `config.protection`.

### Compliance tab — the full-org inventory
The **🛡 Compliance** tab pulls in **every non-archived org repo** (a single
`gh repo list`, cached), not just ones with alerts, so each gets a recorded SOC 2 scope
decision — `needs-compliance` or `out-of-scope` — persisted to `compliance.json` (your
audit record). This is **separate** from the maintained/monitored/ignored dependency
classification: a repo can be dependency-ignored yet still SOC 2 in-scope.

It **seeds** idempotently from where you are: `ignored → out-of-scope`; `maintained /
monitored / pending-PR → needs-compliance`; everything else starts **undecided**, with
repos **dormant 2y+** *pre-suggested* out-of-scope. Bulk actions clear the long tail
(*"Mark N dormant out-of-scope"*, *"Mark all undecided out-of-scope"*), and branch
protection is **checked & enforced only for the in-scope set** — so we never hammer the
API across hundreds of repos. Filters (Undecided / Needs compliance / Out of scope /
All) default to the triage queue; the tab badge is the undecided count.

> First open builds the inventory (~15s for a few-hundred-repo org, then cached, and
> protection badges fill in via a background re-poll). Endpoints: `GET /api/compliance`,
> `POST /api/set-compliance`, `POST /api/compliance-bulk`.

## Configuration

Edit `config.json` (the app creates it from `config.example.json` on first run — it's
git-ignored, so your settings stay local):

| key | default | meaning |
| --- | --- | --- |
| `org` | `your-org` | GitHub org to audit |
| `host` / `port` | `127.0.0.1` / `8787` | local bind (loopback only) |
| `workDir` | `.work` | where repos are cloned for jobs (git-ignored) |
| `alertState` | `open` | which Dependabot alerts to pull |
| `draftPRs` | `true` | open every PR (update, upgrade, bump) as a draft |
| `includeRepos` | `[]` | allowlist (empty = all repos with open alerts) |
| `excludeRepos` | `[]` | repos to skip |
| `branchPrefix` | `dependency-updates/soc2` | update-branch name prefix |
| `npm.force` | `false` | add `--force` to `npm audit fix` (allows major bumps) |
| `autoInstallRuby` | `true` | when a repo's pinned Ruby is missing, `mise install` it (slow; compiles Ruby). Set `false` to skip with instructions instead |
| `autoInstallNode` / `autoInstallGo` / `autoInstallPhp` | `true` | same, for the pinned Node / Go / PHP toolchain |
| `maxConcurrentUpdates` | `3` | update/upgrade/bump jobs run at once (env `MAX_CONCURRENT_UPDATES` overrides) |
| `maxConcurrentFixes` | `1` | CI-fix jobs run at once (a pool separate from updates) |
| `autoFixCI` | `false` | auto-launch a headless Claude fix when a pending PR's CI fails |
| `ciPollSeconds` | `90` | how often to poll pending PRs' CI (min 30) |
| `claudeFix` | *(object)* | CI-fix session: `permissionMode`, `timeoutMinutes` (12), and attempt caps `maxAttemptsPerSha` (2) / `maxAttemptsPerRepo` (4) |
| `autoUpgradeEOL` | `false` | auto-open a runtime-upgrade PR for **maintained** repos on an EOL runtime |
| `eolPollHours` | `12` | how often to re-scan runtimes against endoflife.date (min 1) |
| `autoFixGemConstraints` | `false` | a **blocked** gem auto-opens a constraint-bump PR |
| `claudeBump` | *(object)* | constraint-bump session: `permissionMode` + `timeoutMinutes` (20) |
| `emailHourlyRate` | `200` | legacy — the live rate is the Settings panel / `settings.toml` (`estimate.hourly_rate`) |
| `dismissToken` | `""` | token for the **Dismiss-on-GitHub** calls only — **prefer the `DISMISS_GH_TOKEN` env var or the git-ignored `.dismiss-token` file** over this key (read fresh, no restart; keeps the secret out of your config) — see [Credentials](#credentials--local-setup) |
| `protection` | *(object)* | SOC 2 branch-protection ruleset: `requiredApprovals` (1), `dismissStaleReviews` / `requireConversationResolution` / `blockForcePush` / `restrictDeletion` (all true), `requireCodeOwnerReview` / `allowAdminBypass` (false), `rulesetName` |

`claudeFix` / `claudeBump` are objects, e.g.
`"claudeFix": { "permissionMode": "auto", "timeoutMinutes": 12, "maxAttemptsPerSha": 2, "maxAttemptsPerRepo": 4 }`.

Pin scope to your true client/production set by listing them in `includeRepos`.

> The three automation loops — `autoFixCI`, `autoUpgradeEOL`, `autoFixGemConstraints`
> — default to **off in code**; your `config.json` opts in. Each is
> independent and safe to flip off (see [Autonomous loops](#autonomous-loops)). The
> `autoInstall*` keys default **on** — set one to `false` to skip provisioning that
> toolchain.

## Troubleshooting

**"grant write permissions for `/Library/Ruby/Gems/2.6.0`" / a Bundler repo
produces no changes.** The repo pins an exact Ruby (e.g. `.ruby-version` →
`3.3.7`) that isn't installed via `mise`. Bundler enforces the pin, and without
the right Ruby the command would fall back to macOS **system Ruby 2.6.0**, whose
gem path is read-only. The tool now detects this and skips with a message. To
actually update that repo, install its Ruby once and re-run:

```bash
mise install ruby@3.3.7     # use the version the message names
```

…or set `"autoInstallRuby": true` in `config.json` to have the tool do it.
Note: old apps that pin an uninstalled Ruby and rely on many private/git-sourced
gems (Rails 5/6-era repos) are often framework-upgrade work, not clean security
bumps — expect to handle those by hand.

## SOC 2 Type 2 note

Type 2 is about controls operating *over time*, with **evidence**. Working through this
tool produces several auditable, timestamped records:

- **`compliance.json`** — the in/out-of-scope decision for **every** org repo (the
  change-management *scope* record).
- **Branch-protection rulesets** on every in-scope repo — enforced and recorded on
  GitHub (reviewed PRs, no force-push).
- **`dismissals.json`** — documented, reversible Dependabot dismissals, with the reason.
- **PR history** for every remediation, plus `notifications.json` (client notices),
  `fix-attempts.json` / `upgrade-attempts.json` (automation caps), and archive
  decisions on GitHub.

Work the queue down, complete the compliance inventory, and protect the in-scope
branches — those records are your recurring-review evidence. To produce a dated trail
automatically, this same code can run headless on a schedule (cron/Action).

## Safety

- Binds to loopback only; mutating endpoints reject non-localhost `Host` headers.
- All shell calls use `spawn` with argument arrays (no shell interpolation).
- Archive and PR creation each require an explicit in-browser confirm.
- PRs are drafts; pushes use `--force-with-lease`; nothing auto-merges.
- The autonomous loops are **off by default**, gated per repo class, and
  attempt-capped (2 fixes/commit, 4/repo). Their headless Claude sessions run with
  `--permission-mode auto` inside the disposable `.work/` clone, and commit & push
  **only** to the tool's own `dependency-updates/…` / `runtime-upgrade/…` /
  `gemspec-bump/…` branches — never your default branch.
- `./.work/` (clones) is git-ignored. Delete it anytime with `trash .work`.
