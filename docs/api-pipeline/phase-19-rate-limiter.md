# Phase 19: Two-tier rate limiter + ratelimit_db (cross-cutting, deep)

This is the deep limiter rework deferred from Phase 8. The in-memory limiters move from a boolean
return to a `{remaining, resetSeconds}` shape (so callers can build accurate `Retry-After` and
`RateLimit` headers), a new pg-backed tier-2 backstop lands in `server/ratelimit_db.ts` for the
imminent multi-realm deployment, `RATELIMIT_SCHEMA` is wired into `ensureSchema` under the boot
advisory lock (the exact trap the unwired `DISCORD_SCHEMA` fell into), and `respond429` starts
emitting draft-11 `RateLimit` / `RateLimit-Policy` structured-field headers plus `Retry-After`. It
stays under ~40% of a context window because it is a coherent behavioral slice over the ~5 existing
limiter files plus one new pg module: it consumes the Phase 2 injected `now()` clock and
`FakeRateLimitStore`, the Phase 7 error catalog, and the Phase 8 thin `rateLimit(policy)` adapter
that already sits in every route onion, so it changes the limiter MECHANISM without touching any
route table or the WS wire.

````
### Starter Prompt

This is Phase 19 of the API Pipeline re-architecture: Two-tier rate limiter + ratelimit_db
(cross-cutting, deep). Model: Opus 4.8, xhigh effort. Harness: Claude Code.
ULTRACODE: NOT needed. This is a deep behavioral rework over ~5 files plus one new pg module, not a
large content/test sweep. Hand-spawn 3 parallel agents (below); do not orchestrate via a Workflow.
Goal: Replace the boolean in-memory limiters with a two-tier (in-memory IP gate first, pg-backed
global backstop second) `{remaining, resetSeconds}` resolver, wire RATELIMIT_SCHEMA into
ensureSchema, and emit draft-11 RateLimit headers, with zero route or WS-wire change.

STEP 0 - PRE-FLIGHT
- Run `git status`. The worktree is SHARED with concurrent sessions: if it is dirty with files
  outside this phase's surface, STOP and ask before staging anything. You will commit with EXPLICIT
  paths only, never `git add -A`.
- Confirm you are stacked on the Phase 18 branch (this is a STACKED PR CHAIN; each phase is its own
  green, bisectable PR).
- Scan Claude Code memory for entries in this phase's domain. Concrete topics to look up:
  "PR #1044 Discord integration review" (the DISCORD_SCHEMA-unwired-into-ensureSchema blocker, the
  precedent trap this phase must not repeat), "Server API pipeline audit" (the locked two-tier
  limiter + ratelimit_db decision), "migration-safety" / "additive idempotent DDL" notes, and any
  "shared-worktree commit care" entry.

STEP 1 - LOAD CONTEXT (do NOT read planning docs or large source files directly; spawn ONE Explore
agent). main.ts is ~1695 lines: anchor everything on SYMBOL NAMES and route strings, never line
numbers. Tell the Explore agent to summarize, not dump, these files:
- docs/api-pipeline/state.md and docs/api-pipeline/progress.md (current pipeline state, what Phases
  1 to 18 already landed).
- docs/api-pipeline/phase-19-rate-limiter.md (this file).
- server/ratelimit.ts: exact signatures of `rateLimited` and `recordSlidingWindowAttempt`, the
  `POLICIES` table shape and entries, `authThrottled` (per-username, failed-only, clears on success,
  15m/10-fail), `rateLimitedPerfReport`, the sliding-window Map(s), and every named limit/window
  constant (including `DISCORD_MAX_PER_MINUTE`).
- Every CALL SITE of `rateLimited` / `recordSlidingWindowAttempt` across server/ (grep both symbols):
  the Phase 8 thin adapter, the auth handler (authThrottled), the perf-report handler, the wallet
  handlers, and any other direct caller. Return the full list with the boolean-consuming expression
  at each site. KNOWN SHARED-BUDGET CONSTRAINT: the main.ts fused `rateLimited(req)` condition is
  ONE deliberate per-IP budget covering FOUR paths (register, login, desktop-login/create,
  desktop-login/exchange; the in-code comment records why: exchange is unauthenticated
  defense-in-depth, create bounds the code-store growth). The two-tier rework must PRESERVE that
  shared keying (or split it as an explicit maintainer decision); a naive per-policy
  `auth.login`/`auth.register` isolation would silently change all four budgets. Also note POST
  /api/daily-rewards/spin carries NO limiter by the Phase 18b parity decision (the one-spin-per-day
  409 and the wallet-eligibility 403 are the only guards, neither a throttle); adding one is a
  maintainer fork for THIS phase, not a silent add.
- server/db.ts: how `ensureSchema` assembles its statement list and runs each under
  `pg_advisory_xact_lock`, plus the `DISCORD_SCHEMA` wiring precedent (PR #1044/#1075) so this phase
  wires RATELIMIT_SCHEMA the same proven way.
- server/bug_report_db.ts: the single-statement atomic UPSERT + idempotent `CREATE TABLE IF NOT
  EXISTS` pattern to model `server/ratelimit_db.ts` on.
- server/discord_db.ts: where `DISCORD_SCHEMA` is defined (the unwired-precedent) and where
  `DISCORD_MAX_PER_MINUTE` lives.
- The prior-phase spine this phase CONSUMES under server/http/: the thin `rateLimit(policy)` adapter
  from Phase 8 (its file and signature), `errors.ts` + `error_codes.ts` from Phase 7 (the existing
  429 stable code and the `mapError` rate-limited path / `respond429` helper), `context.ts` from
  Phase 5 (ctx.ip via requestIp, the injected `now()` clock from Phase 2), and the registry barrel.
- The Phase 2 test scaffolding: the injected `now()` clock seam, the `FakeRateLimitStore`
  implementing the tier-2 interface, and the fake-http / `fakeCtx` helpers (their module paths).
- server/CLAUDE.md (server conventions, DDL/ensureSchema rules) and root CLAUDE.md (invariants).
Explore agent returns: the exact current limiter API surface and full call-site list; the POLICIES
shape and every backing named constant; how ensureSchema runs DDL under the advisory lock and the
DISCORD_SCHEMA precedent; the bug_report_db UPSERT pattern; the Phase 8 adapter signature and the
respond429 / 429-code location; and the Phase 2 clock + FakeRateLimitStore interfaces. No raw file
dumps: signatures, symbol names, and the call-site list only.

STEP 2 - CHOOSE ORCHESTRATION + EXECUTE
Hand-spawn 3 parallel Agents, each owning a complete vertical slice (behavior plus its tests), each
given ONLY the Explore summary (not the raw files):
- Agent A (return-shape rework): in server/ratelimit.ts, change `rateLimited` and
  `recordSlidingWindowAttempt` from boolean to `{remaining, resetSeconds}` using the Phase 2 injected
  `now()` clock; update EVERY in-memory call site (the Phase 8 adapter, authThrottled handler-check,
  perf-report handler-check, wallet handler-checks) to consume the new shape while PRESERVING each
  one's existing semantics (authThrottled stays handler-level per-username/failed-only/clears-on-
  success/15m-10-fail; rateLimitedPerfReport still returns 200 by design). Deliverables:
  - new return shape with no boolean caller remaining;
  - tests asserting `{remaining, resetSeconds}` accuracy by advancing the injected clock across the
    window boundary (no Date.now in the tested logic).
- Agent B (tier-2 pg backstop + DDL wiring): create server/ratelimit_db.ts modeled on
  bug_report_db.ts: a global-keyed single-statement atomic UPSERT (one PRIMARY-KEY row per (policy,
  key)) that is the tier-2 backstop; define `RATELIMIT_SCHEMA` as idempotent `CREATE TABLE IF NOT
  EXISTS` DDL; ADD `RATELIMIT_SCHEMA` to the `ensureSchema` statement list under
  `pg_advisory_xact_lock` (the DISCORD_SCHEMA trap) and add a boot-time table-existence assertion.
  Tier-1 in-memory IP gate runs FIRST so floods never reach pg. Deliverables:
  - server/ratelimit_db.ts (atomic UPSERT against the injected clock, FakeRateLimitStore-compatible);
  - RATELIMIT_SCHEMA wired into ensureSchema + boot assertion;
  - idempotent-DDL re-run test (running ensureSchema twice is safe), boot-assertion test, and tier-2
    tests over the FakeRateLimitStore.
- Agent C (two-tier resolver + respond429 headers): swap `POLICIES` to the two-tier resolver with
  per-policy algorithm, values DERIVING from the existing named constants (DISCORD_MAX_PER_MINUTE and
  the per-limiter window/max constants), never re-typed literals; add the `discord.*` (ip+account),
  `character.create/rename/delete/takeover`, and `reports.create` policies to the table; make the
  Phase 8 thin adapter call the two-tier resolver (tier-1 then tier-2); upgrade `respond429` to emit
  `Retry-After` plus draft-11 `RateLimit` and `RateLimit-Policy` structured-field headers (q/w/r/t
  fields per RFC 9651, pinned to the draft version, draft-ietf-httpapi-ratelimit-headers-11, in a
  code comment), and STOP emitting the legacy header trio. Deliverables:
  - two-tier resolver + the new policy rows;
  - respond429 header upgrade;
  - tests asserting exact `Retry-After` and RateLimit/RateLimit-Policy field values via the injected
    clock, and that tier-1 rejects before tier-2 is written (the pg-write counter stays 0 under flood).
This phase has NO documented a/b split. If context approaches 40%, land the completed agent slices as
their own green commits and resume the remaining slice in a fresh session rather than pushing past
the bound.

INVARIANTS THIS PHASE MUST KEEP
- Server-authority: all limits resolve server-side; the client never decides throttling.
- Determinism in tests: every window / Retry-After / RateLimit assertion advances the Phase 2
  injected `now()` clock. NEVER introduce `Date.now`/`performance.now`/`Math.random` into the
  limiter logic under test. This is SERVER-ONLY: do NOT touch src/sim (the sim-purity guard in
  tests/architecture.test.ts must stay green).
- Stable-code i18n: the server stays language-agnostic. respond429 emits an existing stable CODE
  from server/http/error_codes.ts (the rate-limited code), never English prose. If a policy needs a
  brand-new code, add it APPEND-ONLY to error_codes.ts; client-side resolution and the per-surface
  code-parity guard are Phase 22's job, so do not edit src/main.ts or the client catalog here.
- Additive idempotent DDL: RATELIMIT_SCHEMA is `CREATE TABLE IF NOT EXISTS`, wired into the
  ensureSchema statement list under `pg_advisory_xact_lock`, with a boot-time table-existence
  assertion. There is no migrations directory; the inline DDL IS the schema. Re-running ensureSchema
  is safe.
- No magic values: POLICIES values DERIVE from the existing named constants. The full no-magic-values
  consolidation is Phase 24; do not re-tune any limit or window here, only re-home it through the
  resolver.
- Single-flag dispatch + catch-all delegate model is untouched: this phase changes the limiter the
  Phase 8 adapter calls, not the dispatcher or the route tables.
- No em dashes, no en dashes, no emojis anywhere (code, comments, tests, commits, docs).

OUT OF SCOPE (do not let these creep in)
- The security-headers top-level wrapper and Content-Type/Origin enforcement (Phase 21).
- The REST i18n matcher, `userFacingApiError`, the `apiError.*` client catalog, and the per-surface
  code-parity guard (Phase 22). Codes emitted here resolve client-side THERE.
- The /metrics exporter and structured logger (Phase 23). Expose the pg-write counter only through
  the Phase 8 injectable no-op sink seam; do not add prom-client or a real exporter here.
- The validated loadConfig and the no-magic-values sweep (Phase 24).
- The World Market realm-scope fix and backfill (Phase 20).
- Adding new limiter SURFACES beyond discord/character/reports (already decided in their migration
  phases); this phase only promotes them into the two-tier resolver. The Phase 18b families arrive
  with their legacy limiter facts fixed (github: githubRateLimited; desktop-login: the shared
  register/login per-IP budget; daily-rewards: none): promoting or changing those is the explicit
  fork above, not scope creep.
- Any change to a route table, the dispatcher, the WS wire protocol, or WS snapshots.

STEP 3 - VALIDATION + MULTI-AGENT REVIEW
Run the validation matrix for this change type (code + new pg persistence/DDL):
- `npx tsc --noEmit`
- `npx vitest run tests/server/ratelimit.test.ts tests/server/ratelimit_db.test.ts` and the http
  middleware test (e.g. `npx vitest run tests/server/http/rate_limit.test.ts`), plus any existing
  affected suite the Explore agent flagged (auth, wallet, perf-report).
- Persistence/DDL: the idempotent-DDL re-run test and the boot-time table-existence assertion test
  must pass.
- `npm run ci:changed` (Biome on changed files only; scoped `npx @biomejs/biome check --write <file>`
  on each changed file if needed, never a whole-tree write).
- `npm run build:server`.
- If error_codes.ts gained a new append-only rate-limit code, also run
  `npx vitest run tests/localization_fixes.test.ts` (S3).
Then dispatch review agents, ONLY those whose surface this diff touches (check
`git diff --name-only` first), each prompted for COVERAGE not filtering (report every correctness or
requirement gap with confidence and severity; do not pre-filter):
- `privacy-security-review`: REQUIRED. This is a security control (rate limiting) plus new SQL and a
  new table. Have it check tier-1-before-tier-2 ordering (no pg amplification under flood), key
  derivation (ip vs ip+account), the UPSERT for injection safety, and that no secret or internal SQL
  text leaks in a 429 body.
- `migration-safety`: REQUIRED. New persistence (server/ratelimit_db.ts), new DDL, and the
  ensureSchema wiring. Have it confirm the DDL is additive and idempotent, RATELIMIT_SCHEMA is in the
  statement list under the advisory lock, the boot assertion fires, and re-running is safe.
- `qa-checklist`: REQUIRED at phase completion.
- Do NOT spawn `cross-platform-sync` or `architecture-reviewer`: no IWorld/src/sim/wire/matcher
  change, no sim change.
Add this truncation-resume line to every review dispatch: "If your review is truncated, resume from
the last file you fully covered and continue; do not restart." Do not commit until each reviewer
reports no BLOCKING finding (apply BLOCKING and SHOULD-FIX before committing).

STEP 4 - COMMIT CADENCE (Conventional Commits with a scope, EXPLICIT paths; this phase ships as its
own green PR on top of Phase 18):
- `refactor(server): rate limiters return {remaining, resetSeconds} via injected clock`
  (server/ratelimit.ts + every call site + tests/server/ratelimit.test.ts).
- `feat(server): ratelimit_db tier-2 pg backstop, wire RATELIMIT_SCHEMA into ensureSchema`
  (server/ratelimit_db.ts, server/db.ts, tests/server/ratelimit_db.test.ts).
- `feat(http): two-tier rate-limit resolver + respond429 draft-11 RateLimit headers`
  (server/http/middleware/<rate-limit-adapter>.ts, server/http/errors.ts, the POLICIES module,
  tests/server/http/rate_limit.test.ts).
- `feat(server): add discord/character/reports policies to the two-tier table` (the POLICIES module;
  fold into the prior commit if small).
- `docs(api-pipeline): record Phase 19 limiter rework` (docs/api-pipeline/progress.md, state.md).

STEP 5 - ACCEPTANCE CRITERIA (verifiable)
- [ ] `rateLimited` and `recordSlidingWindowAttempt` return `{remaining, resetSeconds}`; no boolean
      caller remains anywhere in server/.
- [ ] Every limiter call site updated; authThrottled stays handler-level (per-username, failed-only,
      clears on success, 15m/10-fail); rateLimitedPerfReport still returns 200 by design.
- [ ] server/ratelimit_db.ts exists: a global-keyed single-statement atomic UPSERT tier-2 backstop
      with idempotent `CREATE TABLE IF NOT EXISTS` DDL, modeled on bug_report_db.ts.
- [ ] `RATELIMIT_SCHEMA` is in the ensureSchema statement list under `pg_advisory_xact_lock`, with a
      passing boot-time table-existence assertion.
- [ ] Tier-1 in-memory IP gate runs FIRST; under a simulated flood the pg tier-2 is never written
      (the pg-write counter stays 0).
- [ ] respond429 emits `Retry-After` plus draft-11 `RateLimit` and `RateLimit-Policy`
      structured-field headers (q/w/r/t) with a pinned draft-version comment; the legacy header trio
      is gone.
- [ ] POLICIES is a two-tier resolver with per-policy algorithm; every value DERIVES from an existing
      named constant (no re-typed literal, no re-tuned limit/window).
- [ ] The `discord.*` (ip+account), `character.create/rename/delete/takeover`, and `reports.create`
      policies are present in the table.
- [ ] Idempotent-DDL re-run test green; window/Retry-After/RateLimit tests use the injected clock; no
      Date.now in tested limiter logic.
- [ ] `tsc --noEmit` clean; ratelimit + ratelimit_db + http middleware tests green; `build:server`
      green; `ci:changed` clean; no WS-wire or src/sim change; no em dashes/emojis.

STEP 6 - DOC UPDATES + MEMORY
- Update docs/api-pipeline/progress.md and docs/api-pipeline/state.md naming the specific additions:
  the new module server/ratelimit_db.ts, the new RATELIMIT_SCHEMA table (one PRIMARY-KEY row per
  (policy, key)), the `{remaining, resetSeconds}` limiter return shape, the two-tier resolver and its
  per-policy algorithm, the draft-11 RateLimit/RateLimit-Policy header emission with the pinned draft
  constant, the new policies (discord.*, character.*, reports.*), and the pg-write counter seam.
- Record surprising rules in memory: the DISCORD_SCHEMA-unwired precedent and how this phase avoids
  it (RATELIMIT_SCHEMA in the ensureSchema list under the advisory lock + boot assertion); why
  authThrottled cannot be a pre-handler middleware (body-username keyed, failure-counted, cleared on
  success); the tier-1-before-tier-2 ordering invariant (floods never reach pg); and that the draft-11
  RateLimit header is a non-final Internet-Draft pinned by comment.

STEP 7 - FINAL RESPONSE FORMAT
Report: phase status (done / blocked); files touched (absolute paths); validation results (tsc,
vitest suites, build:server, ci:changed, S3 if run); review verdicts (privacy-security-review,
migration-safety, qa-checklist, each with BLOCKING/SHOULD-FIX counts); any deferrals (with the phase
that owns them); and a one-line handoff to "Phase 19 QA".

STOPPING RULES (stop and surface, do not push through)
- STOP if any change would alter the WS wire protocol or WS snapshots.
- STOP if determinism or sim-purity would be violated (do not touch src/sim; do not introduce
  Date.now into tested limiter logic, use the injected clock).
- STOP if RATELIMIT_SCHEMA cannot be added to the ensureSchema statement list under
  `pg_advisory_xact_lock` with a boot assertion: do not ship a defined-but-unwired schema (the
  DISCORD_SCHEMA trap).
- STOP if the two-tier resolver would change a policy's effective limit or window versus its existing
  named constant (values DERIVE, they are not re-tuned here).
- STOP if tier-1 ordering cannot guarantee floods never reach pg.
- STOP if the 429 response changes in any way OTHER than the documented knownDeviation (status stays
  429; the legacy header trio is replaced by Retry-After + draft-11 RateLimit/RateLimit-Policy; the
  emitted body code is unchanged). Record it as a knownDeviation; do not change the status.
````
