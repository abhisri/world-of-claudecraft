# Phase 24: Validated config + server timeouts + no-magic-values consolidation + perf gate

This is the cross-cutting hardening phase that closes the pipeline: it promotes the pure
`loadConfig(env)` seed from Phase 2 into a validated fail-fast read done ONCE at boot, sets the
node:http server timeouts in `startServer()` with named constants (mindful of the WS upgrade
handshake and the 1 MB card upload), consolidates every scattered tunable literal into a single
named-constant source of truth (with POLICIES values DERIVING from those constants rather than
re-typing them), and codifies the perf/tick-jitter acceptance gate that protects the non-goal
"no realtime regression." It is sized low-context because it is a consolidation pass over code
already landed in Phases 1 to 23: no new routes, no new persistence, no new player text, no WS
wire change. There is no documented a/b split. The whole phase fits well under the 40% bound, so
run it in one session with a parallel agent fan-out.

### Starter Prompt

````
This is Phase 24 of the API Pipeline re-architecture: Validated config + server timeouts + no-magic-values consolidation + perf gate.
Model: Opus 4.8, xhigh effort. Harness: Claude Code.
ULTRACODE: NOT needed. This phase is a bounded consolidation over existing code (no large content/test sweep). Hand-spawn the parallel agents below; do not orchestrate via a Workflow.
Goal: Read env ONCE through a validated fail-fast loadConfig(env), set the four node:http server timeouts and every tunable as named constants (POLICIES deriving from them, no literal twice), and add a perf/tick-jitter acceptance gate, all with zero behavior change.

STEP 0 - PRE-FLIGHT
- Run `git status`. The worktree is SHARED with concurrent sessions. If it is dirty with files outside this phase's scope, STOP and ask which paths are yours; commit only with EXPLICIT paths, never `git add -A`.
- Scan Claude Code memory (the MEMORY.md index) for entries in this phase's domain. Suggested concrete topics to pull: (1) "Server API pipeline audit" and the api-pipeline progress/state, (2) any prior note on server boot config / process.env reads / startServer, (3) the PR #1044 DISCORD_SCHEMA-unwired precedent (a boot-wiring trap analogous to "read env once at boot"), (4) any prior perf-harness / tick-budget note. Report back the 2 to 4 you found and what each implies for this phase.

STEP 1 - LOAD CONTEXT (do NOT read the planning docs or server/main.ts directly; spawn ONE Explore agent)
Tell the Explore agent to summarize, anchored on SYMBOL NAMES and route strings (main.ts is ~1695 lines, every line anchor in the SPEC is stale):
- docs/api-pipeline/state.md and docs/api-pipeline/progress.md (current packet state, what Phases 1 to 23 landed, any open deferrals that name config/timeouts/perf).
- docs/api-pipeline/phase-24-config-timeouts.md (this file).
- server/http/config.ts (the pure `loadConfig(env)` created in Phase 2): its current signature, what it validates today, and whether the boot call site already calls it or still reads process.env directly.
- server/main.ts AND every other server/ module: the `startServer()` export (Phase 1) and where `createServer`/`listen`/the SIGTERM drain live; the dispatcher selection wired in Phase 9 (the env dispatch flag name and where it is read); and EVERY scattered `process.env.*` read on the boot or request path across ALL of server/ (list each with its enclosing symbol; grep the whole directory, not just main.ts: server/daily_rewards.ts reads WOC_DAILY_REWARD_SERVICE_SECRET per request, WOC_DAILY_REWARD_SERVICE_URL, and WOC_DAILY_REWARD_CONFIG_TTL_MS at module load; server/desktop_login.ts owns the plain named constant DESKTOP_LOGIN_TTL_MS, a no-magic-values sweep item, NOT an env read). CARVE-OUT the deliberate per-request secret reads: require_internal_secret.ts (RESTART_COUNTDOWN_SECRET / DISCORD_BOT_SECRET) and the daily-reward gate read their env PER REQUEST by design (env-unset means feature-off/fail-closed at request time; a boot-time-once read would change behavior). Name them as conscious exceptions to the loadConfig-once rule or re-decide them explicitly in this phase; do not silently fold them into the boot config.
- server/http/registry.ts and server/http/index.ts (the dispatcher barrel from Phase 9): how the new-vs-old path is selected and what flag controls it.
- The rate-limit modules from Phase 19 (server/ratelimit.ts and server/ratelimit_db.ts) and the POLICIES table: every place a limit/window value is re-typed as a literal vs derived from a constant.
- The body middleware from Phase 8 (server/http/middleware/*: withBody/withRawBody): the maxBytes/byte-cap literals and the 1 MB card cap.
- server/CLAUDE.md and root CLAUDE.md (the server/http seam, the no-magic-values + module-first conventions, the determinism/sim-purity invariant).
- The EXISTING perf harness: locate it (candidates: tests/ perf suites, scripts/*.mjs perf tours, the `npm run bench` headless path, any hud_perf_budget/perf_tour analog) and report exactly how it is invoked and what it measures (request latency vs world-loop tick p95).
What the Explore agent must RETURN: (a) a full inventory of scattered process.env reads (file + symbol + the env key + its current default); (b) a full inventory of magic tunable literals grouped by class: rate limits + windows, byte caps, page sizes, timeouts, TTLs, pool sizes, maxPayload, drain window, each with current value and where POLICIES re-types it; (c) the current loadConfig(env) signature and validations; (d) the startServer() signature and where createServer/listen happen; (e) the dispatch flag name + read site; (f) where the perf harness lives and how to run it; (g) an explicit confirmation that NO DDL/JSONB/WS-wire/src/sim file is in this phase's scope.

STEP 2 - CHOOSE ORCHESTRATION + EXECUTE
Low-context phase, no a/b split. Hand-spawn THREE parallel agents, each owning a complete vertical slice (behavior + its tests) and given ONLY the Explore summary (not the raw files):
- Agent A (config loader + boot wiring): Make `loadConfig(env)` in server/http/config.ts a VALIDATED, FAIL-FAST, PURE function of its `env` argument (no top-level process.env capture at module eval). It must throw a clear English boot error naming the missing/invalid key for every required setting (HSTS-in-prod, REQUIRE_WEB_LOGIN, realm/native-app origins, limiter DSN, the dispatch flag). Wire the boot path to call it ONCE and thread the result; replace the scattered process.env reads found in Explore with reads off the config object. Log the active dispatch path at boot, and if the OLD ladder is active while NODE_ENV=production, emit an explicit alert log line (dev-channel English, not a t() key). Deliverables: validated loadConfig; boot call-site refactor; tests that missing/invalid required env throws fast, that the dispatch flag cannot silently select the un-hardened old path in prod without the alert, and that loadConfig is a pure function of its arg.
- Agent B (server timeouts + named-constant consolidation): Set requestTimeout, headersTimeout, keepAliveTimeout, and maxHeaderSize in `startServer()` using NAMED CONSTANTS, mindful that (i) the WS upgrade handshake must not be killed, (ii) a 1 MB card upload over a slow mobile link must complete, (iii) headersTimeout must EXCEED keepAliveTimeout to avoid premature 408. Consolidate EVERY tunable from Explore's inventory into named constants, each with a unit suffix in the name or a one-line comment stating its unit, in a single source of truth. Make POLICIES values DERIVE from those constants (e.g. `WINDOW_MS`/`MAX_PER_WINDOW`), never re-typed literals. Deliverables: the constants module (or block) with unit comments; the four timeouts equal to their constants; POLICIES rewritten to reference the constants; tests that each timeout equals its named constant, that each POLICIES field equals its source constant, and a no-duplicate-tunable-literal assertion.
- Agent C (perf/tick-jitter acceptance gate): Define the gate constants `PIPELINE_ADDED_P99_BUDGET_MS` (the pipeline adds under this many ms p99 per request; start at 1.0 and tune to the harness) and `TICK_P95_CEILING_RATIO = 0.8` against `DT_MS = 50` (tick p95 must stay under 0.8 x DT = 40 ms). Add the acceptance gate test driving the EXISTING perf harness Explore located: it asserts the migrated pipeline path adds under PIPELINE_ADDED_P99_BUDGET_MS p99 vs the bare old ladder, and that running the request layer does not push world-loop tick p95 above TICK_P95_CEILING_RATIO x DT_MS. If wall-clock timing makes the gate flaky, gate on a deterministic derived metric (e.g. a counted-work proxy) instead of raw ms, and document the chosen X-ms threshold and its measurement in a comment; do NOT ship a flaky timing test. Deliverables: the gate constants; the gate test; a one-line note in the test header on how it is run.

INVARIANTS THIS PHASE MUST KEEP
- Determinism + src/sim/ purity: this is SERVER-ONLY. Do NOT touch src/sim/. The perf gate may IMPORT the sim to measure tick p95, but must not modify it; reading the sim from a test does not violate the architecture guard. No Math.random/Date.now in sim logic is unaffected here.
- Single-flag dispatch + catch-all delegate model: Phase 24 READS the dispatch flag through loadConfig and logs/alerts on the active path. It does NOT flip the default (Phase 25 does) and does NOT delete the old ladder.
- Server-authority and no gameplay change: consolidating constants must be byte-equal to today's values; no limit, window, cap, page size, TTL, pool size, or drain window may change value.
- Stable-code i18n: this phase adds NO player-visible string. Config/boot errors and the old-path-in-prod alert are DEV-CHANNEL English (throw/console at boot, never surfaced to a UI), so they are correctly English-only and out of i18n scope. Do not add a t() key.
- No persistence change: no DDL, no JSONB shape change, no ensureSchema edit.
- No magic values: the central deliverable; every tunable is a named constant with a unit, single source of truth, POLICIES derived.
- No em dashes, en dashes, or emojis anywhere (code, comments, docs, commit text). Use commas, colons, parentheses, or "to" for ranges.

OUT OF SCOPE (do not do these here)
- Flipping the env-flag default to the new path (Phase 25, docs-flag-flip).
- Deleting the old if-ladder or naming its deletion exit criteria (Phase 25).
- The `npm run new:endpoint` scaffold (Phase 25).
- The big doc pass (server/CLAUDE.md / new server/http/CLAUDE.md / i18n docs): Phase 25 owns it. Phase 24 updates ONLY docs/api-pipeline/progress.md and state.md (packet tracking).
- The logger facade, /metrics exporter, and /livez//readyz health (Phase 23, already landed; this phase only consumes the metric hook for the perf gate if useful).
- Any rate-limiter BEHAVIOR change (Phase 19 owns the limiter rework; here POLICIES only DERIVES its existing values from constants).
- Any new route, schema, error code, or BOLA loader.

STEP 3 - VALIDATION + MULTI-AGENT REVIEW
Run the validation matrix for this change type (config + a perf test, server-only):
- `npx tsc --noEmit`
- `npx vitest run tests/server/http/config.test.ts` (new/extended) and the new perf gate test, plus any existing server suite the boot refactor touches (run the affected tests/server/*.test.ts).
- `npm run ci:changed` (Biome on changed files only; never a whole-tree --write).
- `npm run build:server` (the boot/timeout change must compile and bundle).
- Pre-merge gate (mirror CI before opening the PR): `npm test && npx tsc --noEmit && npm run build:env && npm run build:server && npm run build`.
- S3 i18n guard is NOT required (no player text changed); if you accidentally added a player-facing string, STOP, that is out of scope.
Then dispatch review agents, ONLY those whose surface this diff touches (check `git diff --name-only` first). For Phase 24 that is:
- `privacy-security-review`: server/ boot config is touched, including the fail-fast required-env reads, the limiter DSN, and the guard that the dispatch flag cannot silently select the un-hardened OLD path in prod. Prompt it for COVERAGE (report every gap with confidence + severity), not filtering.
- `qa-checklist`: the end-of-contribution gate.
Do NOT dispatch migration-safety (no DDL/JSONB), cross-platform-sync (no IWorld/sim/wire/matcher/RL change), or architecture-reviewer (no src/sim/ change). If a reviewer's output is truncated, tell it: "resume from the last complete finding; do not restart." Do not commit until each dispatched reviewer reports no BLOCKING.

STEP 4 - COMMIT CADENCE (Conventional Commits, scope, EXPLICIT paths; this phase ships as its own green PR in the stacked chain)
Suggested 4 commits:
1. `feat(http): validated fail-fast loadConfig read once at boot` -- server/http/config.ts, server/main.ts, tests/server/http/config.test.ts
2. `feat(server): set http server timeouts in startServer with named constants` -- server/main.ts, server/http/config.ts (constants)
3. `refactor(server): consolidate tunables into named constants; POLICIES derive` -- server/http/config.ts, server/ratelimit.ts, server/ratelimit_db.ts, server/http/middleware/* (only the changed ones), tests/server/*
4. `test(server): perf and tick-jitter acceptance gate` -- the perf gate test + the gate constants
Plus a final `docs(api-pipeline): record phase 24 in progress and state` -- docs/api-pipeline/progress.md, docs/api-pipeline/state.md. Keep it a STACKED PR: open this phase as its own bisectable green PR on top of Phase 23's branch.

STEP 5 - ACCEPTANCE CRITERIA (verifiable checkboxes; the QA correctness agent will check every one)
- [ ] `loadConfig(env)` is a PURE function of its `env` arg (no top-level process.env capture) and is called exactly ONCE at boot; the boot path threads the returned config.
- [ ] Missing or invalid required env (HSTS-in-prod, REQUIRE_WEB_LOGIN, realm/native-app origins, limiter DSN, dispatch flag) makes boot FAIL FAST with a clear English error naming the key (test proves it throws).
- [ ] No scattered `process.env.*` reads remain on the boot or request path that loadConfig should own (grep/inventory confirms each is replaced).
- [ ] The active dispatch path is logged at boot; if the OLD ladder is active while NODE_ENV=production, an explicit alert log line is emitted (test proves the alert fires).
- [ ] requestTimeout, headersTimeout, keepAliveTimeout, and maxHeaderSize are set in `startServer()` and EQUAL their named constants; headersTimeout exceeds keepAliveTimeout; the values allow the WS upgrade handshake and a 1 MB card upload (documented in a comment).
- [ ] Every tunable (rate limits + windows, byte caps, page sizes, timeouts, TTLs, pool sizes, maxPayload, drain window) is a named constant with a unit (in the name or a comment), single source of truth; no tunable literal appears twice (asserted).
- [ ] POLICIES values DERIVE from the named constants (a test asserts each policy field equals its source constant); no limit value changed vs today.
- [ ] Perf gate codified: `PIPELINE_ADDED_P99_BUDGET_MS` and `TICK_P95_CEILING_RATIO` (0.8) x `DT_MS` (50) are named constants; the gate test passes and is not flaky.
- [ ] tsc clean; `npm run build:server` green; Biome on changed files clean; full `npm test` green.
- [ ] No WS wire change, no DDL/JSONB change, no src/sim/ change in the diff.

STEP 6 - DOC UPDATES + MEMORY
- Update docs/api-pipeline/progress.md (mark Phase 24 done; record the new/changed symbols: validated `loadConfig`, the named-constant tunable block, the four startServer timeouts, the `PIPELINE_ADDED_P99_BUDGET_MS`/`TICK_P95_CEILING_RATIO`/`DT_MS` gate constants) and docs/api-pipeline/state.md (current state, that only Phase 25 remains).
- Record in Claude Code memory the surprising boot/timeout rules worth keeping: node headersTimeout MUST exceed keepAliveTimeout (else premature 408); requestTimeout must not strangle the WS upgrade or a slow 1 MB card upload; loadConfig must be pure (no module-eval process.env capture) so config is testable; the dispatch-flag-active-in-prod alert is the safety net against silently serving the un-hardened old path.

STEP 7 - FINAL RESPONSE FORMAT (return verbatim, concise)
- Phase status: DONE / BLOCKED.
- Files touched (absolute paths).
- Validation results (tsc, vitest, build:server, ci:changed, full suite): pass/fail each.
- Review verdicts (privacy-security-review, qa-checklist): no-BLOCKING / list.
- Deferrals (anything pushed to Phase 25 or a follow-up).
- One-line handoff: "Phase 24 QA next (docs/api-pipeline/phase-24-qa.md)."

STOPPING RULES (stop and surface to the user before proceeding)
- Stop if setting any server timeout would break the WS upgrade handshake or could truncate a legitimate 1 MB card upload; pick safer constants and document why.
- Stop if any change would alter the WS wire protocol or a snapshot shape.
- Stop if consolidating a constant would change a POLICIES value or any limiter/cap/window behavior. This phase is strictly non-behavioral; values must be byte-equal to today.
- Stop if the perf gate cannot be made deterministic (do not ship a flaky wall-clock test); gate on a derived proxy and document the threshold instead.
- Stop if making config testable would require reading env at module-eval time; loadConfig must stay a pure function of its `env` argument.
- Stop if determinism or src/sim/ purity would be violated (e.g. measuring tick p95 would require editing a sim file).
- Stop if the diff would touch DDL, JSONB shape, ensureSchema, or any persistence module.
````
