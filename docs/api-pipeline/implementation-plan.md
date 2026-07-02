# API Pipeline Re-Architecture: implementation plan

The end-to-end plan for re-architecting every JSON endpoint on the authoritative game
server (`server/`) behind one in-house request pipeline. This file is the table of
contents, the canonical per-phase workflow, and the 25-phase summary table. It does NOT
inline the per-phase prompts: each phase's full spec, deliverables, and acceptance checks
live in its own `phase-NN-<slug>.md`, paired with a `phase-NN-qa.md`. Read
[README.md](README.md) for the packet overview and [brainstorm.md](brainstorm.md) for the
option exploration and trade-off reasoning behind the locked decisions.

Goal: maintainability, security, testability, observability. NOT a concurrency-scalability
fix (the single-threaded 20 Hz world loop is the real per-realm ceiling and is a separate,
out-of-scope workstream), NOT a gameplay change, NOT a WebSocket wire change. No heavy web
framework, zero new runtime dependencies (the one weighed exception is `prom-client`, and
only when the `/metrics` exporter lands in Phase 23).

## Contents

1. [Delivery model](#delivery-model)
2. [Team workflow (every phase)](#team-workflow-every-phase)
3. [Review Dispatch Matrix](#review-dispatch-matrix)
4. [Code hygiene](#code-hygiene)
5. [Agent scaling](#agent-scaling)
6. [Phase ordering principles](#phase-ordering-principles)
7. [The 26 phases (summary table)](#the-26-phases-summary-table)

## Delivery model

- Every phase runs **Opus 4.8 at `xhigh` effort**. Plan the phase end to end, carry it to a
  green PR without pausing after each step, and anchor every step on a check you can run
  (`npx tsc --noEmit`, `npx vitest run <file>`, `npm run build:server`), never on "looks
  done."
- **Delivery is a stacked PR chain.** Each phase is its own green, bisectable PR branched on
  the prior phase's branch. The suite stays green at every commit. Small phases, small PRs,
  small reviews, paired with the roughly 40%-context-per-phase bound.
- **A single all-or-nothing env dispatch flag** controls whether the new pipeline sits in
  front of the old `handleApi` ladder. The new path is the DEFAULT and is the path the
  suite targets. The new dispatcher delegates un-migrated paths to the old ladder via a
  per-path catch-all, so partially migrated states stay correct while the chain is in
  flight. Rollback is one flag flip: all migrated routes revert to the old ladder at once.
- **Accepted tradeoff (chosen knowingly):** a flag flip reverts the hardening too (new
  limiters, BOLA loaders, the bearer-gap close, security headers, the em-dash fix all live
  on the new path). The old ladder is deleted in the NEXT release once Phase 25's metric
  exit criteria are clean. PRECONDITION for that deletion: the Phase 18b late-arrival
  families (github, desktop-login, daily-rewards, brought in by release merges after their
  would-have-been waves) must be migrated or recorded as permanent delegates first;
  otherwise the old-path metric never goes quiet and the deletion drops live routes.
- **CORS, the OPTIONS-204 short-circuit, and the security-headers wrapper stay as top-level
  `createServer` wrappers** covering BOTH the old and new paths, so a routing rollback can
  never drop CORS, preflight, or security headers. They are not inside the per-route onion
  only.
- The exact env var name is fixed by the validated `loadConfig(env)` in Phase 24; the boot
  logs the active dispatch path and alerts if the old path is active in production.

## Team workflow (every phase)

Each `phase-NN-<slug>.md` instantiates these five steps against its own diff. The phase
file is the spec; this section is the standard procedure that wraps it.

### Step 0: pre-flight and memory scan

- Confirm a clean worktree and the correct branch (stacked on the prior phase's branch, not
  `main`). The worktree is shared by concurrent sessions: commit with EXPLICIT paths, never
  `git add -A`.
- Re-anchor every reference on SYMBOL NAMES and route strings, never line numbers. All
  file:line anchors in the source SPEC are stale (`main.ts` has moved); re-find each symbol
  before touching it.
- Scan the maintainer's memory index (`MEMORY.md`) for prior notes relevant to the phase
  (Discord wiring traps, the i18n reword-staleness blind spot, the DISCORD_SCHEMA precedent,
  prior PR reviews on the touched surface). Pull anything load-bearing into the working set.

### Step 1: Explore load

- Read the phase-NN file in full, plus the cross-phase docs it assumes:
  [README.md](README.md), this plan, [qa-checklist.md](qa-checklist.md),
  [state.md](state.md), and [progress.md](progress.md).
- Read the real `server/` source for the surface this phase touches, located by symbol name
  and route string. Verify intent against code, not against the stale SPEC line anchors.

### Step 2: choose orchestration and execute

- Pick the orchestration that fits the phase shape (see [Agent scaling](#agent-scaling)):
  - **Parallel Agent fan-out** across independent files or subsystems for most phases.
  - **A Workflow** for batch-heavy phases (the route-migration phases that port many routes
    in one pass, e.g. Phase 10, Phase 17), where deterministic fan-out over a route list
    beats ad-hoc subagents.
- Execute the phase deliverables. Land new logic as small, tested modules under
  `server/http/` (or a per-domain route module), never as a new method cluster on a
  monolith. Write the tests alongside the code.

### Step 3: validation and review dispatch

- Run the validation matrix for the phase:
  - Baseline (any code change): `npx tsc --noEmit` + the affected
    `npx vitest run tests/server/<domain>.test.ts` + `npm run ci:changed` (Biome on changed
    files only).
  - Spine and primitive phases: `npx vitest run tests/server/http/*.test.ts`.
  - Player text or codes touched: `npx vitest run tests/localization_fixes.test.ts` (the S3
    guard) + the per-surface code-parity test.
  - Persistence or DDL touched: the idempotent-DDL re-run test + the JSONB save/load
    round-trip test.
  - Pre-merge gate (mirrors CI): `npm test && npx tsc --noEmit && npm run build:env &&
    npm run build:server && npm run build`.
  - WS wire and snapshots are NOT expected to change. If a phase would change them, STOP and
    surface it.
- Dispatch reviewers per the [Review Dispatch Matrix](#review-dispatch-matrix). Spawn ONLY
  the reviewers whose surfaces the diff actually touches (`git diff --name-only`).

### Step 4: doc and memory updates

- Update [progress.md](progress.md) (what shipped) and [state.md](state.md) (active phase,
  open questions, carryover into the next phase).
- Update `server/CLAUDE.md`, `server/http/CLAUDE.md`, and the root `CLAUDE.md` seam notes
  when the phase changes the developer-facing contract (Phase 25 owns the final doc pass).
- Append a memory note for any non-obvious decision or trap so the next session inherits it.

## Review Dispatch Matrix

Spawn only the reviewers whose surfaces the phase diff touches. `qa-checklist` runs at every
phase completion; the rest are conditional.

| Reviewer | Dispatch when the diff touches | Typical phases |
|---|---|---|
| `qa-checklist` | Always, at every phase completion | All |
| `privacy-security-review` | `server/` auth, BOLA, rate limit, security headers, secrets, or SQL | Nearly every phase, esp. 08, 11, 12, 14, 16, 17, 18, 19, 21 |
| `migration-safety` | `server/db.ts`, `ratelimit_db.ts`, `discord_db.ts` wiring, the market fix, or any DDL / JSONB shape change | 16, 19, 20 |
| `cross-platform-sync` | `IWorld`, `src/sim/`, the wire, the `sim_i18n` / `server_i18n` matchers, or the RL surface | 22 (the client matcher) only; packet is otherwise server-only |
| `architecture-reviewer` | `src/sim/` changes | None (this packet must not touch `src/sim/`) |

## Code hygiene

- **Module-first under `server/http/`.** The spine (`router`, `compose`, `context`,
  `schema`, `errors`, `error_codes`, `registry`, `index`, `config`, `middleware/*`) is a
  domain-agnostic set of small modules. Each domain exports `export const routes:
  RouteDef[]` from `server/<domain>.ts` with THIN handlers; domain functions take no
  req/res so the same core serves REST and WS and is unit-testable. NEVER grow `main.ts`.
- **New code gets tests.** Every new module lands with its `tests/server/http/<primitive>.test.ts`
  or `tests/server/<domain>.test.ts`. The harness phase (Phase 2) builds the fake-http/Ctx,
  the injected clock, the FakeDb interfaces, the golden-master normalizer, and the parity
  driver the later phases assert against.
- **Additive, idempotent DDL.** Persistence is additive idempotent DDL at boot under the
  advisory lock (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
  There is no migrations directory; the inline DDL is the schema. Any new schema constant
  (e.g. `RATELIMIT_SCHEMA`) MUST be added to the `ensureSchema` statement list with a
  boot-time table-existence assertion. This is the exact trap the unwired `DISCORD_SCHEMA`
  fell into.
- **Dead-code removal.** Migrating a route off the old ladder removes the now-dead branch in
  the same PR once parity is green. Wire the orphaned `handleSwagClaim` rather than leaving
  it unreachable. Do not leave both paths live past the flag flip beyond what the
  catch-all delegate requires.
- **Import cleanup.** Remove unused imports as routes move between modules; keep the
  dependency set tiny and add no runtime dependency (the lone weighed exception is
  `prom-client` in Phase 23).
- **No generated-file edits.** Do not hand-edit generated artifacts; regenerate via the
  build. Biome runs on CHANGED FILES ONLY (`npm run ci:changed`); scoped
  `npx @biomejs/biome check --write <changed-file.ts>` is fine, a whole-tree `--write` is
  never run.
- **Invariants every phase keeps:** server stays language-agnostic (emit a stable machine
  code, localize at the client boundary); no em dashes, en dashes, or emojis anywhere;
  Conventional Commits with a scope (`feat(http): ...`, `fix(server): ...`,
  `test(server): ...`).

## Agent scaling

Opus 4.8 under-spawns by default, so fan out deliberately, then review for coverage.

- **Scale the fan-out to the phase context risk.** A `low`-risk phase is usually one
  focused agent. A `medium`-risk phase fans out 2 to 3 parallel agents across the
  independent files or subsystems it touches (spine module, its test, the parity fixture).
  A `high`-risk phase (Phase 17) splits along its internal a/b boundary and prefers a
  Workflow over the route batch.
- **Use a Workflow for batch-heavy migration phases.** When a phase ports many routes in one
  pass, deterministic Workflow fan-out over the route list beats ad-hoc subagents and keeps
  each route's parity fixture isolated.
- **Do not spawn for work doable in one response.** Reserve fan-out for genuinely
  independent files, subsystems, or batch items.
- **Review for coverage before declaring done.** Have a fresh subagent review the diff: its
  job is COVERAGE (report every correctness or requirement gap with confidence and
  severity), not filtering. Then run the named reviewers from the Review Dispatch Matrix.
- **Phases flagged for an internal a/b split** (08, 09, 17, 23) say so in their own file:
  split when context approaches the 40% bound, otherwise keep the phase whole.

## Phase ordering principles

- **Foundation and harness first.** The importable spine (Phase 1), the test scaffolding
  harness (Phase 2), and the surface re-inventory plus golden corpus (Phase 3) land before
  any primitive, because the whole safety net depends on them. The spine primitives (router,
  onion, validator, error model, middleware, registry, Phases 4 to 9) land before any route
  moves.
- **One domain per migration phase, behind the flag, with parity tests.** Each migration
  phase (Phases 10 to 18, plus the 18b late-arrivals insert for the families release merges
  added after the fact) ports a single domain onto RouteDefs, diffs every route against
  the Phase 3 golden fixtures, and keeps the new path behind the dispatch flag with the
  old ladder reachable via the catch-all delegate. Lowest-risk reads migrate first
  (Phase 10), the heaviest sub-router (admin, Phase 17) later.
- **Cross-cutting deep work last.** The two-tier rate limiter (19), the market realm-scope
  fix and backfill (20), the security-headers wrapper (21), the REST i18n matcher (22), the
  logging and metrics layer (23), and the validated config plus perf gate (24) come after
  the migration wave, because each spans the whole surface and is cleanest once the routes
  are already on the seam. The market fix is its own persistence PR under the
  `migration-safety` reviewer, outside the routing rollback story.
- **Every implementation phase gets a paired QA phase.** `phase-NN-<slug>.md` is always
  paired with `phase-NN-qa.md`, which instantiates the shared [qa-checklist.md](qa-checklist.md)
  against that phase's diff.
- **Phase 25 closes the loop.** It flips the env-flag default to the new path (old ladders
  retained behind the flag), names the old-ladder deletion exit criteria for a next-release
  follow-up, and its QA phase offers packet teardown once the chain has merged.

## The 26 phases (summary table)

Each implementation phase `phase-NN-<slug>.md` is paired with its QA phase `phase-NN-qa.md`.
The `ctx` column is the synthesis context-risk estimate; every phase must stay under roughly
40% of a context window.

| Phase | Title | ctx | Key deliverables | Test focus |
|---|---|---|---|---|
| 01 [(QA)](phase-01-qa.md) | [Importable spine + WS-auth extraction](phase-01-importable-spine.md) | low | Importable spine, WS-auth module | Import-without-boot smoke |
| 02 [(QA)](phase-02-qa.md) | [Shared test scaffolding harness](phase-02-test-harness.md) | medium | Fake http/Ctx, FakeDb, parity driver | Normalizer masks placeholders; FakeDb compiles |
| 03 [(QA)](phase-03-qa.md) | [Surface re-inventory + golden corpus](phase-03-surface-inventory.md) | medium | Re-anchor, content-type classify, fixtures | Fixtures reproduce today; route-count gate |
| 04 [(QA)](phase-04-qa.md) | [Table router](phase-04-router.md) | low | Static-Map + :param matcher | 405+Allow, HEAD/OPTIONS, no-regex guard |
| 05 [(QA)](phase-05-qa.md) | [Onion compose + request context](phase-05-onion-context.md) | low | compose + buildContext | Order, double-next, one-response-on-throw |
| 06 [(QA)](phase-06-qa.md) | [Typed schema validator](phase-06-schema-validator.md) | low | Body/params/query decoder | One-pass issues, Infer identity |
| 07 [(QA)](phase-07-qa.md) | [RFC 9457 error model + serializers](phase-07-error-model.md) | medium | mapError, per-surface serializers, codes | Status table, per-surface contracts, no 500 leak |
| 08 [(QA)](phase-08-qa.md) | [Core middleware + metric/log seam](phase-08-middleware.md) | medium | Onion middlewares, metric sink | 413/400 mapping, scope denial, onion order |
| 09 [(QA)](phase-09-qa.md) | [Registry + dispatcher + parity harness](phase-09-registry-parity.md) | medium | Registry, dispatcher-in-front, parity | Path-set diff, prefix order, zero silent diffs |
| 10 [(QA)](phase-10-qa.md) | [Migrate public reads](phase-10-public-reads.md) | medium | Port leaderboard reads | Per-route parity, page bounds, authz-gap close |
| 11 [(QA)](phase-11-qa.md) | [Migrate auth](phase-11-auth.md) | low | Port register/login/attestation | Turnstile order, authThrottled, 404 deviation |
| 12 [(QA)](phase-12-qa.md) | [Migrate characters + BOLA seam](phase-12-characters-bola.md) | medium | Character routes, requireOwned* loader | Cross-account denial, :id-as-NaN reject |
| 13 [(QA)](phase-13-qa.md) | [Migrate account portal + em-dash fix](phase-13-account.md) | medium | Port account portal, em-dash fix | Account parity, em-dash gone, matcher resolves |
| 14 [(QA)](phase-14-qa.md) | [Migrate wallet + cards](phase-14-wallet.md) | medium | Port wallet, card binary body | ip+account order, pre-auth 413, new codes |
| 15 [(QA)](phase-15-qa.md) | [Migrate reports + telemetry + misc](phase-15-reports-telemetry.md) | low | Port reports/telemetry/misc | reports.create limiter, perf 200, 405 preserved |
| 16 [(QA)](phase-16-qa.md) | [Migrate Discord family (net-new)](phase-16-discord.md) | medium | Port Discord, wire schema | OAuth parity, ip-block+turnstile, redirect not json |
| 17 [(QA)](phase-17-qa.md) | [Migrate Admin API](phase-17-admin.md) | high | Port admin sub-router | Envelope frozen, page/limit, enum routes validated |
| 18 [(QA)](phase-18-qa.md) | [Migrate OAuth JSON + Internal](phase-18-oauth-internal.md) | medium | Port OAuth JSON + internal | RFC 6749 envelope, secret gate, GET pages served |
| 18b [(QA)](phase-18b-qa.md) | [Migrate late arrivals: github, desktop-login, daily-rewards](phase-18b-late-arrivals.md) | medium | Port the release-merge families | 12 routes parity-clean, fail-closed ops gate, fused budget kept |
| 19 [(QA)](phase-19-qa.md) | [Two-tier rate limiter + ratelimit_db](phase-19-rate-limiter.md) | medium | Two-tier limiter, ratelimit_db | {remaining,resetSeconds}, tier order, DDL re-run |
| 20 [(QA)](phase-20-qa.md) | [World Market realm-scope fix + backfill](phase-20-market-realm-fix.md) | medium | Realm-scope market, partitioned backfill | Both writers realm-keyed, idempotent partition |
| 21 [(QA)](phase-21-qa.md) | [Security headers wrapper + enforcement](phase-21-security-headers.md) | low | Top-level header wrapper, 415 | Headers everywhere, no COEP, 415 log-only |
| 22 [(QA)](phase-22-qa.md) | [REST i18n matcher + code-parity guard](phase-22-rest-i18n.md) | medium | Code matcher, parity guard | Every code resolves all locales, append-only |
| 23 [(QA)](phase-23-qa.md) | [Logging + /metrics + drain-aware health](phase-23-logging-metrics.md) | medium | Logger, /metrics, /livez+/readyz | reqId propagation, bounded labels, /readyz drain |
| 24 [(QA)](phase-24-qa.md) | [Validated config + timeouts + perf gate](phase-24-config-timeouts.md) | low | loadConfig, timeouts, perf gate | Fail-fast env, no duplicate literals, tick gate |
| 25 [(QA)](phase-25-qa.md) | [Docs + new:endpoint scaffold + flag flip](phase-25-docs-flag-flip.md) | low | Docs, scaffold, flag-default flip | Scaffold compiles, default routes new path |
