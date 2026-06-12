# How the update system works

Every "update" the dashboard performs flows through one pipeline (`createUpdatePR`)
with three trigger families and two autonomous loops around it. The diagram below
renders on GitHub, in VS Code (Mermaid preview), or at <https://mermaid.live>.

```mermaid
flowchart TD
  SCAN["📡 Scan · every load/refresh<br/>Dependabot alerts API + gh repo list<br/>→ per-repo model (counts, packages,<br/>ecosystems, open PRs, dep graph)"]

  SCAN --> TRIAGE{"Triage<br/>classification"}
  TRIAGE -->|Maintained| MAINT["Maintained — we patch it"]
  TRIAGE -->|Monitored| MON["Monitored — notify client (email)"]
  TRIAGE -->|Ignored / Untriaged| IGN["Out of scope / pending decision"]

  MAINT --> T1["🔵 Create update PR · ⚡ Fix All<br/>(manual)"]

  SCAN --> EOLP["⏳ EOL poller · endoflife.date<br/>(on scan + every 12h)"]
  EOLP --> EOLQ{"runtime pinned<br/>past EOL?"}
  EOLQ -->|"maintained + autoUpgradeEOL"| T2["Runtime-upgrade job (auto)"]
  EOLQ -->|"any in-scope repo"| BADGE["⚠ EOL badge + ⬆ Propose upgrade"]
  BADGE -->|manual| T2

  T1 --> QUEUE
  T2 --> QUEUE
  QUEUE["🧵 Job queue — max 3 concurrent<br/>progress streamed via one /api/events"]
  QUEUE --> PIPE

  subgraph PIPE["🛠️ createUpdatePR pipeline (one repo)"]
    direction TB
    P1["1 · Clone (shallow, gh)"] --> P2["2 · Branch<br/>dependency-updates/… or runtime-upgrade/…"]
    P2 --> PUP{"runtime<br/>upgrade?"}
    PUP -->|yes| PWP["writePins — rewrite EOL pin<br/>(.ruby-version / go.mod / composer.json)<br/>→ new version"]
    PUP -->|no| P3
    PWP --> P3
    P3["3 · Bootstrap toolchain via mise<br/>install pinned ruby/node/go/php<br/>install gate: dedup identical + serialize"]
    P3 --> P4["4 · Per-ecosystem update<br/>(mise exec — repo's pinned runtime)"]
    P4 --> PRUBY{"Ruby:<br/>app or gem?"}
    PRUBY -->|"app — Gemfile.lock"| PRA["bundle lock --update<br/>→ patched lockfile (committed)"]
    PRUBY -->|"gem — no lock"| PRG["resolve-to-verify constraints<br/>allow patch? → note only,<br/>no lock committed"]
    P4 --> PNODE["npm / pnpm / yarn<br/>composer · go"]
    PRA --> P5
    PRG --> P5
    PNODE --> P5
    P5{"5 · Any<br/>changes?"}
    P5 -->|no| PNOTE["specific note: exact packages<br/>+ patched targets + reason"]
    P5 -->|yes| P6["6 · Commit → push<br/>(force-with-lease)"]
    P6 --> P7["7 · gh pr create --draft"]
  end

  PNOTE --> NOPR["done · no PR<br/>(already patched / gem covered in consumers)"]
  P7 --> PEND["📥 Pending PR tab · openPRs"]

  PEND --> CIP["⏳ CI poller · gh pr checks (90s)"]
  CIP --> CISTATE{"CI<br/>state?"}
  CISTATE -->|passing| MERGE["✅ ready for human review and merge"]
  CISTATE -->|"failing + capped"| HUMAN["⚠ auto-fix capped — needs a human"]
  CISTATE -->|"failing + autoFixCI + under caps"| FIX["🤖 Headless Claude fix session<br/>--permission-mode auto<br/>fetch failing logs → edit → commit → push"]
  FIX -->|"caps: 2/commit · 4/repo"| CIP

  GUARD["🔒 Guardrails: localhost-only · all PRs draft ·<br/>persisted attempt caps · header kill-switches ·<br/>auto-upgrade = maintained only"]

  classDef trig fill:#1f6feb,color:#fff,stroke:#1f6feb;
  classDef ai fill:#8957e5,color:#fff,stroke:#8957e5;
  classDef warn fill:#9e6a03,color:#fff,stroke:#fff;
  classDef good fill:#1a7f37,color:#fff,stroke:#1a7f37;
  class T1,T2 trig;
  class FIX ai;
  class HUMAN,BADGE,PNOTE warn;
  class MERGE,NOPR good;
```

## The aspects, one by one

**1. Scan → model.** On load / Refresh, `lib/github.js#buildModel` pulls the org's
open Dependabot alerts (paginated) and `gh repo list`, joining them into a per-repo
model: severity counts, flagged packages (with patched targets + GHSA), ecosystems,
open tool-PRs, the published/depends-on dependency graph, classification, and contact.

**2. Triage.** Each repo is **Maintained** (we patch), **Monitored** (inactive client
— we email a notice, no code change), **Ignored**, or **Untriaged**. Only Maintained
repos auto-update / auto-upgrade; the rest are manual.

**3. Triggers into the job queue.**
- **Manual:** `Create update PR` (one repo) or `⚡ Open update PRs for all` (fan-out).
- **EOL auto-upgrade** (poller): a *maintained* repo pinned to an end-of-life runtime →
  a runtime-upgrade job. Any in-scope repo shows a ⚠ badge + manual `⬆ Propose upgrade`.

**4. Job queue + event stream.** All update/upgrade jobs ride one queue capped at 3
concurrent (the heavy work is spawned `gh`/`git`/`bundle`/`npm` child processes, so
they run truly in parallel). Progress fans out over a single `/api/events` NDJSON
stream — survives reload, no per-job connection limit.

**5. The `createUpdatePR` pipeline** (`lib/updater.js`): clone → branch → *(upgrade
only)* `writePins` rewrites the EOL version pin → **bootstrap** installs the repo's
pinned Ruby/Node/Go/PHP via mise (behind an install gate that dedups identical
versions and serializes, so concurrent jobs never corrupt a shared compile) →
per-ecosystem update run **through `mise exec`** so the pinned runtime is used →
check for changes → commit → push → open a **draft** PR.

**6. App vs. library (the Ruby split).** An **app** (committed `Gemfile.lock`) gets the
lockfile bumped to patched versions and committed. A **gem** (gemspec, no lockfile)
is *not* given a committed lockfile — instead we resolve to verify whether its
constraints already permit the patched versions (they usually do — the fix lands in
consuming apps) and only flag a constraint that actually *blocks* a patch. No
ecosystem ever produces a generic "manual remediation needed": every no-change/
failure note lists the exact packages, patched targets, and reason.

**7. Pending PR + CI auto-fix loop.** A new draft PR moves the repo to **Pending PR**.
The CI poller (`gh pr checks`, 90s) reads each PR's status. **Passing** → ready for a
human to review + merge. **Failing** (with `autoFixCI` on and under the caps) → a
**headless Claude session** (`--permission-mode auto`) pulls the failing job logs,
fixes the code, commits, and pushes — CI re-runs and the loop repeats, bounded by
**2 attempts/commit and 4/repo** (persisted, so a fix→push→fail chain can't run away).

**8. Guardrails.** Bound to `127.0.0.1` with a Host-header guard; every PR opens as a
draft; attempt caps + the EOL upgrade dedup are persisted to JSON; both autonomous
loops have header toggles / `POST /api/autofix|autoupgrade` kill-switches; and
auto-upgrade is scoped to **maintained** repos only.
