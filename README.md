# Dependency Dashboard

A **local** triage dashboard for Dependabot security alerts across the
`your-org` GitHub org. It runs on your own `gh` CLI authentication — nothing
hosted, nothing exposed to the internet, and no tokens to manage for the core
workflow. (One optional, least-privilege token unlocks GitHub-native alert
dismissal — see [Credentials & local setup](#credentials--local-setup).)

![The Maintained tab: one remediation card per repo with severity counts,
one-click update PRs, branch-protection warnings, a blocked-gem constraint-bump
flow, and an end-of-life runtime upgrade](docs/maintained-tab.png)

*The Maintained tab — one card per repo with its severity counts and the
remediation that fits: a one-click draft update PR, a branch-protection fix, a
constraint-bump PR for a blocked gem, or a runtime upgrade off an end-of-life
version. Shown with demo data.*

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

## Scope — security advisories only, not routine version bumps

This tool acts on **Dependabot security alerts** — the advisory feed
(`/dependabot/alerts`, backed by GHSA/CVE entries). A package enters the dashboard
**only if it has an open security advisory**; the model is built (almost) entirely from
that feed, across every severity (critical → low — there's no severity floor).

> **The one exception: Hex (Elixir).** GitHub's dependency graph doesn't parse
> `mix.lock`, so Dependabot never scans Hex — a repo's "0 hex alerts" means
> *unscanned, not clean* (its SBOM shows zero hex packages even for a large Elixir
> app). Because the alert feed is blind here, the tool scans Hex **itself**: it reads
> each repo's committed `mix.lock` and cross-references the installed versions against
> GitHub's Advisory Database under the `ERLANG` ecosystem — the same advisory data
> Dependabot uses, just never auto-matched against `mix.lock`. The synthesized
> advisories are merged into the model in the **same shape** as Dependabot alerts, so
> Hex repos flow through the identical triage/tabs/update-PR machinery. See
> [Hex / Elixir scanning](#hex--elixir-scanning). Turn it off with `"hexScan": false`.

It deliberately does **not** touch Dependabot's other feature, **scheduled version
updates** — the `dependabot/*` "Bump X from A to B" PRs your `.github/dependabot.yml`
opens just to keep dependencies current. Those have *no* advisory (e.g. `pagy 43.4 →
43.5`, `roo 2 → 3`, `aws-sdk-s3`, a GitHub Action bump), so the tool neither
generates fixes for them nor merges/closes them. That's intentional: this is a SOC 2
**security-remediation** dashboard, and auto-handling arbitrary (often major,
potentially breaking) version bumps would both dilute the audit trail and risk
breakage. Routine upgrades stay a human decision — review and merge them on GitHub,
or let Dependabot auto-merge if you configure it.

The one place the tool *interacts* with those version-update PRs is read-only/advisory:
on a no-change re-check it may comment `@dependabot recreate` on a `dependabot/*` PR
**only when that PR's target is already satisfied on the default branch** (i.e. it's
superseded) — see [Create update PR](#create-update-pr). It never opens, edits, or
merges a version-update PR.

## Prerequisites

- **Node.js ≥ 18** (`node -v`)
- **GitHub CLI** authenticated: `gh auth status` (needs the `repo` + `read:org`
  scopes — check with `gh auth status`)
- **git**
- **Claude Code CLI** (`claude` on your PATH) — only for the autonomous loops: the
  CI auto-fix and gem constraint-bump spawn a headless `claude` session. Nothing
  else needs it.
- For the update PRs to actually change files, the relevant toolchain must be on
  your PATH: `npm`/`pnpm` for JS, `bundle` (or `mise`) for Ruby, `composer`,
  `go`, and `mix` (Elixir + Erlang, via `mise`) for Hex. Missing tools are skipped
  with a note in the run log — nothing breaks.

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

### 3. Repo-delete token — optional (only for the 🗑 Delete button)

The Compliance tab's **🗑 Delete** permanently deletes a repo on GitHub —
**irreversible**, unlike Archive. Your `gh` token usually *can't* do this (it
lacks the scope by design — a deliberate fail-safe), so deletion needs its own
dedicated token, resolved in this order: `DELETE_GH_TOKEN` env var → a
git-ignored `.delete-token` file. There is **no** config.json fallback on
purpose — a delete credential should never live in config.

- **Fine-grained PAT:** Permissions → Repository → **Administration → Read and
  write** on the repos you'd prune
- **Classic PAT:** the **`delete_repo`** scope

```bash
echo 'github_pat_xxxxxxxx' > .delete-token   # git-ignored, read fresh per request
```

Skip this entirely if you never use Delete — every other action works without it,
and without the token the server returns a clear "can't delete" message instead.

## Run it

```bash
git clone https://github.com/headwayio/dependency-triage-dashboard.git
cd dependency-triage-dashboard
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

Two tabs are about a *decision* rather than about vulnerabilities, so they also cover
repos with **no** open alerts (which never reach the alert feed at all): **Untriaged**
shows every unclassified repo in the org, and **Ignored** shows every ignored one.
Those alert-free repos come from the same full-org inventory the Compliance tab uses,
and render as compact rows below the alerted cards.

| Tab | What lands here |
| --- | --- |
| **Untriaged** | Not yet classified — the triage inbox, covering **every** non-archived org repo, alerts or not. Hidden when empty. |
| **Maintained** | Active client / we host — repos we actually patch. |
| **Pending PR** | Has an open tool-opened PR whose CI is still running, failing, or being fixed. Takes precedence over every other tab, whatever the classification. |
| **Passing PR** | Has an open tool-opened PR with **green CI** but no approval yet — awaiting review. Hidden when empty. |
| **Approved PR** | Has an open tool-opened PR that's **approved** — ready to merge. Hidden when empty. |
| **Covered** | A maintained **gem** whose constraints already permit every patch — no action needed. Hidden when empty. |
| **Monitored** | Inactive client we watch but don't patch — we notify them instead. |
| **Notified** | A monitored repo whose client we've emailed, with no new advisories since. |
| **Ignored** | Out of scope for this tool — including ignored repos with no open alerts. |
| **🛡 Compliance** | A *separate* full-org inventory — **every** non-archived repo, not just alerted ones — for the SOC 2 scope decision + branch protection. See [below](#branch-protection--the-compliance-inventory). |

An open tool PR flows through three lifecycle tabs as it progresses —
**Pending PR** (CI running/failing) → **Passing PR** (green CI, awaiting review) →
**Approved PR** (ready to merge) — so the worklist is sorted by how close each PR is
to merging. Archived repos drop out of GitHub's alert feed entirely, so there's no
archived tab. The headline **"to maintain"** count is Maintained + Pending + Passing
+ Approved (open PRs still count as work until merged) — covered gems and everything
monitored/ignored are excluded. Triage buttons sit on each card in
the **Untriaged** tab; elsewhere they move into a per-card menu. To classify a whole
org's backlog, select rows there (`x`, or `*` for all) and press `m` / `w` / `i` —
Maintain / Monitor / Ignore, the same mnemonics the Compliance tab uses. Marking a
*monitored* repo notified moves it Monitored → Notified, and a **new** advisory
appearing afterward sends it back to Monitored.

## What each action does, precisely

### Archive
`PATCH /repos/your-org/<repo>` with `archived=true`, after an in-browser
confirm. Unarchive anytime in the repo's GitHub settings.

### Delete repo (permanent)
`gh repo delete your-org/<repo> --yes` (`POST /api/delete-repo`), from the
Compliance tab's 🗑 button or the `#` key. **Irreversible** — the repo, its
issues, PRs, and history are gone — so it's double-gated: the in-browser modal
keeps Delete disabled until you type the repo's exact name (GitHub-style), and
the server re-validates that typed confirmation. It also requires the dedicated
delete token (see [Credentials](#credentials--local-setup)); without one, the
request fails closed with instructions rather than falling back to your `gh`
auth.

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
   - **Hex (Elixir)** → `mix deps.update <pkgs>`, run under the repo's pinned
     **Elixir + Erlang** (from `.tool-versions`/`.mise.toml`/`mix.exs`). The targeted
     packages come from the tool's own Hex scan, not Dependabot — see
     [Hex / Elixir scanning](#hex--elixir-scanning). A package a `mix.exs` constraint
     caps below its patched floor is reported in the **Blocked** table for a manual
     constraint bump (the Elixir analog of the gem/parent-constraint case).
4. If nothing changed, it stops and tells you (no empty PR). On this no-change
   path it also **auto-closes any obsolete PR** the tool previously opened for the
   repo — a re-check that produces no diff means the flagged advisories are already
   resolved (e.g. another PR merged the bump), so the stale update PR is closed with
   an explanatory comment and its branch deleted. This mirrors `@dependabot rebase`
   auto-closing a no-longer-needed PR. Scoped to the tool's own
   `branchPrefix` branches — human, runtime-upgrade, and constraint-bump PRs are
   never touched. Disable with `"closeObsoletePRs": false`. The same no-change path
   also comments **`@dependabot recreate`** on the repo's open `dependabot/*` PRs
   that are **already satisfied on the default branch** — the PR's target (from its
   `Bump <pkg> from <a> to <b>` title) is compared against the installed lockfile
   version, so still-needed bumps (pagy, aws-sdk, …) and unverifiable ones
   (github-actions, git-sha pins) are left alone. Dependabot then self-closes the
   superseded ones. Deduped to once per PR per day. Disable with
   `"nudgeDependabotOnClear": false`.
5. Otherwise commit → `git push --force-with-lease` → `gh pr create --draft`. The branch is
   date-stamped, so a same-day re-run refreshes the existing PR. Across days, if a prior
   update PR is still open: when today's freshly-built tree is **identical** to it, nothing
   is opened (it's left as-is); when it **differs**, the new PR is opened and the prior one is
   **superseded** — closed with a "Superseded by #N" comment — so the repo never accumulates
   duplicate update PRs. (Also gated by `"closeObsoletePRs": false`.)

**Minimize major bumps.** Security fixes that exist **within the installed major**
are applied automatically. An advisory whose only fix is in a **higher major**
(no same-major backport — e.g. `devise 4.9.4 → 5.0.4`, where GitHub's affected
range covers all of 4.x) is **held back**: it's excluded from this lockfile-only PR
and listed in the PR body under *"Major upgrades required — not included here"* so
you can opt in deliberately. This determination uses GitHub's range-specific
`first_patched_version` (the floor for *your* version): if its major is higher than
installed, the current major has no fix. Disable with `"minimizeMajorBumps": false`.

The PR body lists every advisory it targeted — with **From / To / Bump** columns
(major/minor bolded so you can eyeball breaking-risk vs patch) — and reminds
reviewers to let CI run before merging. The same From/To/Bump detail (and a red
**major ⚠** flag on forced majors) shows on each repo card's flagged-packages table
in the dashboard. The branch is per-day; a same-day re-run refreshes it.

**npm-ecosystem overrides fallback.** Most npm/pnpm/yarn advisories are on
*transitive* dependencies a targeted `update` can't move (a parent's version range
pins them below the patch), so the gentle update produces no lockfile change. When
that happens, the tool writes `overrides` (npm) / `pnpm.overrides` (pnpm) /
`resolutions` (yarn) pinning each flagged package to `>=patched <nextMajor` and
regenerates the lockfile — reaching transitive deps a normal update can't. A forced
bump can break a dependent, so it opens as a **draft** for CI (and the auto-fix loop)
to validate.

### Hex / Elixir scanning
Every other ecosystem rides GitHub's Dependabot **alert feed**. Hex can't: GitHub's
dependency graph **doesn't parse `mix.lock`**, so Dependabot never scans Elixir — a
repo's "0 hex alerts" means *unscanned, not clean* (its SBOM lists **zero** hex
packages even for a large Elixir app). We confirmed there's no toggle for this: the
[supported-ecosystems table](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)
lists Hex (`mix`) as **version-updates ✓ but security-updates ✗**, and pushing a
`mix.lock` snapshot through the **Dependency Submission API** populates the SBOM yet
still produces **no alerts** (tested: 79 hex packages ingested, 0 alerts after 10 min).

So the tool closes the blind spot itself (`lib/hex.js`):

1. **Scan.** For each candidate repo it reads the committed `mix.lock`, then matches
   the installed versions against GitHub's Advisory Database under the **`ERLANG`**
   ecosystem (pulled once via GraphQL, cached 6h) — the same advisory data Dependabot
   would use, just never auto-matched against `mix.lock`. Each hit is synthesized into
   the **same alert shape** as a Dependabot alert (severity, patched floor, GHSA, …),
   so Hex repos appear in the dashboard and flow through triage/tabs/PRs unchanged.
2. **Which repos.** Every repo whose **primary language is Elixir**, plus any repo
   already surfaced by the Dependabot feed (so a polyglot app — JS frontend + Elixir
   backend — is scanned too). A polyglot repo that is *neither* Elixir-primary *nor*
   otherwise alerted won't be caught automatically; add it to `includeRepos`.
3. **Remediate.** **Create update PR** runs `mix deps.update <pkgs>` (see above). A
   patch held below its floor by a `mix.exs` constraint lands in the PR's **Blocked**
   table; an advisory whose only fix is a **higher major** (e.g. `decimal 2 → 3`, which
   needs coordinated bumps of its dependents) is held back under `minimizeMajorBumps`
   and listed for manual opt-in.

Disable the whole thing with `"hexScan": false`. The advisory query and every
`mix.lock` read are best-effort — a failure degrades to "no hex advisories", never
breaks a Refresh.

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

## Finishing open PRs — consolidate, rebase, review

Once a repo has open tool PRs, a few actions help drive them to merge. They appear on the
Pending / Passing / Approved tabs.

### Consolidate colliding PRs — Rollup / Stack / Sequence

When **≥2** of a repo's open tool PRs branched off the same base **and** change the same
lockfile (`package-lock.json`, `Gemfile.lock`, …), they can't all merge cleanly — the second
to merge invalidates the first's lockfile. The dashboard detects that cluster (server-side,
authoritative) and offers three ways out on the card banner; you pick per repo:

- **⬆ Roll up → 1 PR** — a high-effort headless session merges every branch onto a fresh
  `release/deps-<date>` branch, regenerates the lockfile **once** so all upgrades coexist,
  opens a single PR to review & squash-merge, and **closes the originals** in its favor.
  Fewest PRs; review the whole batch together. (`lib/rollup.js`, `/api/rollup`.)
- **🥞 Stack → N ordered PRs** — a session merges each PR onto the one below it (regenerating
  the lockfile each time), pushes the rewritten branches, then **retargets each PR's base** to
  the branch below so its diff shows only its own delta. Merge bottom-up; GitHub retargets
  each to the base as its parent lands. Keeps every PR independently reviewable.
- **⏱ Sequence → merge in order** — no code changes now: records a blocked-by ordering and
  comments it on each PR. When a blocker merges, the dashboard **auto-rebases** the next PR
  (merge base + regenerate the lockfile) on the next poll. Lightest touch; resolves the clash
  lazily at merge time. (Stack/sequence live in `lib/consolidate.js`, `/api/consolidate`; the
  ordering is persisted in `pr-links.json` and the auto-rebase runs in `pollSequenceLinks`.)

Stacked / sequenced PRs carry a **🥞 stacked on #N** / **⏱ after #N** badge, and the banner
stops offering to consolidate PRs that are already linked — so it's clear which way a clash
was resolved and you can't double-apply it.

### ⟳ Rebase / Update branch (per PR)

A PR that's **behind** its base or **conflicting** shows a Rebase button. It launches a
headless session that merges the base in, regenerates the lockfile, resolves conflicts, and
pushes — CI then re-runs. (`createRebasePR` in `lib/rollup.js`, `/api/rebase`.)

### 👤 Request review

A ready (non-draft, unapproved) PR shows **Request review from @who** — a static label plus
a name chip with a **▼** caret. Clicking the chip requests that person immediately.

The caret opens a **picker, not a menu of actions**: names tick and untick, and the whole diff
is sent as one `gh pr edit --add-reviewer … --remove-reviewer …` when the menu closes (every
close path funnels through `closeAllMenus`). Applying per click would fire a request per
toggle, and an accidental untick would un-request someone with no chance to put them back
before the menu shut. A close with no changes sends nothing.

The default is the person you normally ask on **that repo**: reviewers are collected from its
last 30 PRs, open and closed, most-recent-first — whoever was requested, else whoever actually
reviewed. Anyone already requested is ticked, and the chip's default skips past them, so a PR
that already has one reviewer can still get a second. Once everyone is requested the chip goes
inert but the caret stays live — otherwise there'd be no way to remove anyone.

A repo nobody has reviewed yet has no history to suggest from, so the picker falls back to the
**org roster** (`/orgs/{org}/members`, cached an hour). The authed user is filtered out of both
lists — every tool PR is authored by them, and GitHub rejects a self-review request. Teams are
supported and requested as `org/slug`.

### 💬 Review console (Copilot + reviewer comments)

A PR with unresolved review threads shows a **💬 Review N** button that opens a per-PR
console (`lib/reviews.js`). It lists every thread (Copilot 🤖 / human 👤 with file:line + diff
context), auto-triages the **Copilot** ones with an advisory *fix / skip* suggestion, and lets
you **skip** any. Hitting **Address** runs one headless session that, per comment, either makes
the smallest reasonable fix **or rejects it** (when the comment is wrong / out of scope) —
then pushes and **replies to + resolves each thread** with a tailored note (the fix's commit,
or the reason it was rejected). Skipped comments stay open. Keyboard: `j`/`k` move, `x` skip,
`a` address, `h`/`l` prev/next PR, `o` open, `esc` close.

### 🗒 Session log

Every headless session's output is archived per repo (`session-history.json`) and viewable
after the fact from the card's **⋯ → 🗒 Session log** menu (newest first, each expandable).
Retention is PR-aware: a session tied to a PR is kept **until that PR merges/closes**, then
pruned on the next Refresh.

## How the headless Claude sessions are seeded

Several actions launch a **headless `claude -p` session** in a local clone to do work a
script can't — fixing failing CI, unblocking constraint-capped patches, major upgrades,
release rollups, rebasing a stale branch, and addressing PR review comments. Every one of
these routes through `runClaude` in `lib/fixer.js`, which injects a **shared system prompt**
(`SESSION_PREAMBLE`, via the CLI's `--append-system-prompt`) so each session has consistent
context about where it's running and how to behave. The preamble tells the session:

- It's running **fully autonomously** — a headless `claude -p` with no human in the loop
  mid-run — **inside this Dependency Dashboard**, which triages Dependabot alerts across the
  org and launched it to carry out one specific remediation.
- It's in a **fresh local clone of one repo** on a branch the dashboard already checked out;
  stay in that repo.
- **Non-interactive**: never ask questions or wait for confirmation (nobody can answer) —
  decide from the evidence and proceed.
- A human **watches the output stream live** in the card/console log, so narrate briefly.
- Use the repo's **pinned toolchain through mise** (`mise exec -- …`) so versions match CI;
  regenerate lockfiles with the package manager rather than editing them by hand.
- Keep the change **minimal and scoped**; never stage tracker/state files (`.beads/`,
  `.DS_Store`, editor configs).
- **Defer to the task prompt** for what to commit and whether to push / open a PR — unless it
  says otherwise, the dashboard handles pushing, opening PRs, and replying to review threads.

That last point is why the shared preamble carries **no task-specific git directives**: those
differ per action (the CI-fix session pushes its own branch; rollup/rebase/review let the
dashboard push) and live in each action's own prompt. Reasoning effort, model, and timeout
are per-session knobs (`claudeFix` / `claudeUnblock` / `claudeMajor` / `claudeRollup` /
`claudeReview` config blocks); the breaking-change sessions default to max effort.

The one exception is the **Copilot comment triage** (the advisory "fix / skip" suggestions in
the review console): that's a quick, read-only, no-clone one-shot, so it carries its own
focused prompt rather than the code-editing preamble.

## Autonomous loops

![The Pending PR tab: each open update PR with its review state and live CI
checks — a draft with failing checks offers a one-click Fix CI that launches a
headless Claude session, next to an approved PR with checks passing](docs/pending-tab.png)

*The Pending PR tab — where opened PRs live while CI runs or they're being fixed.
Each card shows the PR's review state and live CI checks: the failing one offers
**🔧 Fix CI** (the headless Claude loop below). As a PR progresses it advances to the
**Passing PR** tab (green CI, awaiting review) and then **Approved PR** (the
merge-ready worklist). All three PR tabs carry the same bulk actions to copy every PR
link for Slack or open them all in the browser. Shown with demo data.*

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

The per-repo cap exists to stop a fix→new-SHA→fail runaway, so the poller **releases it
once that chain has ended** — either when every open PR on a repo is passing (none
failing, none still running, at least one actually green), or when the repo has no open
tool PR at all, meaning the work merged or was closed. Otherwise the budget only ever
counts down: a repo where the fixer *worked* four times would be capped exactly like one
where it never worked, and attempts spent on a PR that has since merged would count
against it forever. The per-commit cap still bounds any single SHA.

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

### ⚠ Dependabot silent — when the alert feed is lying

Dependabot failing is not the problem; Dependabot failing **quietly** is. Every way it dies
looks the same from outside — the updater goes quiet, with no error, no PR, and a green tick
on the last job it ran. The Compliance tab checks for two of them.

#### ⏱ Idle — a configured ecosystem stopped running

The blunt question: this repo asks for weekly `hex` updates, so when did a version-update
job for `hex` last actually run? An ecosystem quiet for more than **2× its interval (plus a
day)** gets flagged. That catches every cause at once — `open-pull-requests-limit` reached,
GitHub pausing a schedule, or a persistent job error — without needing to model any of them.

Costs one `gh run list` per repo, no log downloads. Two details matter: dependabot.yml names
ecosystems differently from the job labels (`mix` → **`hex`**, `npm` → `npm_and_yarn`,
`gomod` → `go_modules`), and **security** jobs are excluded — they're alert-driven and keep
firing after the scheduled ones have stopped, so counting them as liveness would mask
exactly the failure being looked for.

Real example: a repo whose `hex` updates stopped for 105 days because it had hit the default
`open-pull-requests-limit: 5`. Its `github-actions` ecosystem (3 open PRs) kept running the
whole time, and its npm *security* jobs did too — so from the Actions tab it looked alive.

#### ⚠ Blocked — an unreachable git dependency

A dependency pulled straight from a git repo (`gem "x", github: "org/x"`,
`"pkg": "github:org/pkg"`) has to be **cloneable** during resolution. If Dependabot can't
reach it, the resolver can't build the dependency graph at all — so **every** dependency
in that project silently stops updating, not just the unreachable one. The update job
still reports *success*; there's simply no PR and no alert.

That makes it the same class of blind spot as [Hex](#hex--elixir-scanning): the repo
looks clean because nothing scanned it. Observed on a real repo where one unreachable
git gem blocked all 28 gems that needed an update — security updates included — for six
weeks, with nothing in the UI to show for it.

Affected repos get a red **⚠ dependabot blocked** badge (idle ones get an amber
**⏱ dependabot idle**), a **⚠ Dependabot silent** filter appears covering both, and each
cause gets its own banner — same symptom, different fix, so merging them would muddle both.
Blocked outranks idle on a repo that's somehow both: the unreachable dep is usually the
*cause* of the silence and names a concrete fix. Detection is predictive rather than log-scraping — it
reads each repo's manifests plus the org's Dependabot access policy
(`GET /orgs/{org}/dependabot/repository-access`), so it fires the moment someone *adds*
a private git dep rather than after a run has already failed, and it can name the fix.
A dep whose visibility can't be determined is treated as reachable: a false "your
scanning is broken" would train you to ignore the badge.

**The fix is an org setting**, not something the dashboard can apply: Settings → Code
security → *Dependabot private repository access*, granting the named repo. Via the API:

```bash
gh api --method PATCH /orgs/<org>/dependabot/repository-access \
  -F 'repository_ids_to_add[]=<repo-id>'
```

Repo *visibility* is not the issue — private projects get Dependabot fine. Only the
git-sourced **dependency** needs to be reachable.

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

![The Compliance tab: the full-org SOC 2 inventory with per-repo engagement
tracking, branch-protection status with one-click protect/unprotect, derived
audit scope with logged overrides, and archive/delete pruning](docs/compliance-tab.png)

*One row per org repo: how it's tracked (Maintain / Monitor / Ignore), whether
its default branch enforces the SOC 2 ruleset, and its derived audit scope —
with logged overrides for the rare exception. Shown with demo data.*

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
| `org` | `your-github-org` | GitHub org to audit |
| `host` / `port` | `127.0.0.1` / `8787` | local bind (loopback only) |
| `workDir` | `.work` | where repos are cloned for jobs (git-ignored) |
| `alertState` | `open` | which Dependabot alerts to pull |
| `draftPRs` | `true` | open every PR (update, upgrade, bump) as a draft |
| `closeObsoletePRs` | `true` | on a no-change re-check, auto-close the tool's now-obsolete update PR for that repo (comment + delete branch); scoped to `branchPrefix` branches |
| `nudgeDependabotOnClear` | `true` | on a no-change re-check, comment `@dependabot recreate` on the repo's open `dependabot/*` PRs **already satisfied on the default branch** so Dependabot self-closes them (deduped once/PR/day); still-needed/unverifiable PRs are left alone |
| `minimizeMajorBumps` | `true` | apply only same-major security fixes automatically; hold back advisories whose only fix is a higher major (listed in the PR body for manual opt-in) |
| `hexScan` | `true` | scan Hex (Elixir) repos against GitHub's `ERLANG` advisory DB (the Dependabot feed omits `mix.lock`) and merge the results into the model — see [Hex / Elixir scanning](#hex--elixir-scanning) |
| `includeRepos` | `[]` | allowlist (empty = all repos with open alerts) |
| `excludeRepos` | `[]` | repos to skip |
| `branchPrefix` | `dependency-updates/soc2` | update-branch name prefix |
| `npm.force` | `false` | add `--force` to `npm audit fix` (allows major bumps) |
| `autoInstallRuby` | `true` | when a repo's pinned Ruby is missing, `mise install` it (slow; compiles Ruby). Set `false` to skip with instructions instead |
| `autoInstallNode` / `autoInstallGo` / `autoInstallPhp` | `true` | same, for the pinned Node / Go / PHP toolchain |
| `autoInstallElixir` | `true` | when a Hex update runs, `mise install` the repo's pinned Erlang + Elixir if missing. Set `false` to skip (the update no-ops without a toolchain) |
| `maxConcurrentUpdates` | `3` | update/upgrade/bump jobs run at once (env `MAX_CONCURRENT_UPDATES` overrides) |
| `maxConcurrentFixes` | `1` | CI-fix jobs run at once (a pool separate from updates) |
| `autoFixCI` | `false` | auto-launch a headless Claude fix when a pending PR's CI fails |
| `ciPollSeconds` | `10` | how often to poll pending PRs' CI + review state (min 5). One GraphQL call batches every pending PR per cycle, which is what makes a cadence this fast cheap |
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

- Binds to loopback only. Mutating endpoints reject non-localhost `Host` headers
  (DNS rebinding) **and** any cross-site `Origin` (CSRF) — a malicious web page
  can't fire mutations at your local server.
- All shell calls use `spawn` with argument arrays (no shell interpolation).
- Archive, protect/unprotect, and PR creation each require an explicit
  in-browser confirm.
- **Delete repo** is the only irreversible action and is double-gated: a typed
  confirmation matching the repo name (validated client *and* server side), plus
  a dedicated delete token your normal `gh` auth deliberately doesn't have.
- PRs are drafts; pushes use `--force-with-lease`; nothing auto-merges.
- The autonomous loops are **off by default**, gated per repo class, and
  attempt-capped (2 fixes/commit, 4/repo). Their headless Claude sessions run with
  `--permission-mode auto` inside the disposable `.work/` clone, and commit & push
  **only** to the tool's own `dependency-updates/…` / `runtime-upgrade/…` /
  `gemspec-bump/…` branches — never your default branch.
- `./.work/` (clones) is git-ignored. Delete it anytime with `rm -rf .work`.
