# API Pipeline Re-Architecture: Progress Tracker

Status board for the 25-phase stacked PR chain that re-architects every JSON
endpoint on the authoritative game server behind one in-house request pipeline.
Canonical decisions live in the planning packet (see `canonical.md` / `README.md`);
each implementation phase has a `phase-NN-<slug>.md` file and a paired `phase-NN-qa.md`.

Mark a row's Status as "In progress" or "Done" and fill Started / Completed
(YYYY-MM-DD) as work lands. Keep deliverable and QA boxes in sync with the PR.

## Overall status

| Phase | Status | Started | Completed |
|---|---|---|---|
| Phase 01 | Done | 2026-06-30 | 2026-06-30 |
| Phase 01 QA | Done | 2026-06-30 | 2026-06-30 |
| Phase 02 | Done | 2026-06-30 | 2026-06-30 |
| Phase 02 QA | Done | 2026-06-30 | 2026-06-30 |
| Phase 03 | Done | 2026-06-30 | 2026-06-30 |
| Phase 03 QA | Done | 2026-06-30 | 2026-06-30 |
| Phase 04 | Done | 2026-06-30 | 2026-06-30 |
| Phase 04 QA | Done | 2026-06-30 | 2026-06-30 |
| Phase 05 | Done | 2026-06-30 | 2026-06-30 |
| Phase 05 QA | Done | 2026-06-30 | 2026-06-30 |
| Phase 06 | Not started |  |  |
| Phase 06 QA | Not started |  |  |
| Phase 07 | Not started |  |  |
| Phase 07 QA | Not started |  |  |
| Phase 08 | Not started |  |  |
| Phase 08 QA | Not started |  |  |
| Phase 09 | Not started |  |  |
| Phase 09 QA | Not started |  |  |
| Phase 10 | Not started |  |  |
| Phase 10 QA | Not started |  |  |
| Phase 11 | Not started |  |  |
| Phase 11 QA | Not started |  |  |
| Phase 12 | Not started |  |  |
| Phase 12 QA | Not started |  |  |
| Phase 13 | Not started |  |  |
| Phase 13 QA | Not started |  |  |
| Phase 14 | Not started |  |  |
| Phase 14 QA | Not started |  |  |
| Phase 15 | Not started |  |  |
| Phase 15 QA | Not started |  |  |
| Phase 16 | Not started |  |  |
| Phase 16 QA | Not started |  |  |
| Phase 17 | Not started |  |  |
| Phase 17 QA | Not started |  |  |
| Phase 18 | Not started |  |  |
| Phase 18 QA | Not started |  |  |
| Phase 19 | Not started |  |  |
| Phase 19 QA | Not started |  |  |
| Phase 20 | Not started |  |  |
| Phase 20 QA | Not started |  |  |
| Phase 21 | Not started |  |  |
| Phase 21 QA | Not started |  |  |
| Phase 22 | Not started |  |  |
| Phase 22 QA | Not started |  |  |
| Phase 23 | Not started |  |  |
| Phase 23 QA | Not started |  |  |
| Phase 24 | Not started |  |  |
| Phase 24 QA | Not started |  |  |
| Phase 25 | Not started |  |  |
| Phase 25 QA | Not started |  |  |

## Phase 01: Importable spine + WS-auth extraction (the gate, zero behavior change)

Deliverables:
- [x] Export startServer() and guard main.ts's module-load self-invoke (require.main === module, NOT import.meta) so the module imports without binding a socket
- [x] Lift authenticateWebSocket/onConnection/upgrade out of main() into an importable ws_auth module (createWsAuth(deps) factory mirroring the wallet_link/SocialService IO-pure split, not a one-line export)
- [x] Expose the createServer prefix dispatcher as a pure function (routeHttpRequest)
- [x] A smoke test that imports the module without booting

QA:
- [x] Fixes applied
- [x] Tests added (tests/server/ws_auth.test.ts 17 + tests/server/importable_spine.test.ts 1 = 18, all green)
- [x] Dead code removed (type WebSocket import narrowed out of main.ts)
- [x] Reviews clean (privacy-security-review: no findings; cross-platform-sync: NO WIRE CHANGE; qa-checklist: READY)

Notes:
- New surface: server/ws_auth.ts (createWsAuth(deps) -> { authenticateWebSocket, onConnection, attachUpgrade(server, wss) }); server/main.ts exports startServer(): Promise<http.Server> and routeHttpRequest(req, res). NO server/http/ spine module created (that is Phase 4+).
- Entrypoint guard: esbuild leaves import.meta EMPTY under format: 'cjs' (the bundle is the only launch path: npm run server / npm run realms both exec node dist-server/server.cjs), so the working guard is require.main === module, NOT the import.meta comparison drafted in the SPEC. Verified: build:server emits no import.meta warning; the bundled dist-server/server.cjs boots, serves GET /api/status -> 200, and stops cleanly on SIGTERM; a Vitest import() binds no socket and opens no DB connection.
- Cleanliness pass (per user request): the WS handshake wire vocabulary (rejection strings, the 1008 close + reason, leave reasons, the 10000ms timeout, the /ws path) lives in named constants (WS_AUTH_ERROR, TOO_MANY_CONNECTIONS_CLOSE, LEAVE_REASON, AUTH_TIMEOUT_MS, WS_UPGRADE_PATH) with a single rejectHandshake(ws, error) helper, no scattered magic literals. Wire VALUES byte-identical (the 18 tests assert literal frames). The HTTP prefix ladder is intentionally left inline; Phase 4 turns it into a route table.
- QA pass (phase-01-qa.md, 2026-06-30): 5 read-only auditors (correctness, test-coverage, dead-code, privacy-security-review, cross-platform-sync). 0 BLOCKING. cross-platform-sync verdict NO WIRE CHANGE (9 handshake frames + {t:hello} shape + 1008 close all byte-identical); privacy-security-review no CRITICAL/WARNING (check order, per-IP gate, and server authority preserved; the new console.error logs the SyntaxError not the raw token frame). Applied ALL findings (2 SHOULD-FIX + 4 nits, per user "apply everything so nothing accumulates"): strengthened the IP-gate test to assert the isConnectionRefused input bag and added real-predicate refuse + admin-bypass cases; added tests/server/route_dispatch.test.ts pinning routeHttpRequest (OPTIONS-204 short-circuit, public CORS '*', /internal + /admin/api prefix dispatch via mocked sub-dispatchers); added mutedUntil precedence/fallback, an accept-path socket-stays-open assertion, and a moderation-before-character order test; fixed the stale main().catch() comment (also clearing its em dash). The three server test files went 19 -> 28 tests. Full mirror gate green (572 files / 6033 tests, tsc, build:env, build:server, build); the bundled dist-server/server.cjs re-confirmed self-invoke -> listen -> GET /api/status 200 -> clean SIGTERM. NOTE (not a finding): main.ts carries PRE-EXISTING em dashes (dev comments + the player-facing rate-limit strings) that the SPEC defers to Phase 13/22 under a userFacingApiError matcher-lockstep constraint; left untouched on purpose.

## Phase 02: Shared test scaffolding harness (the phase the SPEC is missing)

Deliverables:
- [x] One faithful fake-http helper (FakeRes: setHeader/getHeader/getHeaders/removeHeader/headersSent/writableEnded/writeHead-merge/write/guarded-end + makeReq with node-faithful lower-cased headers) + a fakeCtx(overrides) producing the frozen Ctx (refactor-ready for Phase 5 buildContext) + a nextGuard() onion primitive
- [x] Inject a now() clock into ratelimit.ts (default Date.now) for deterministic window tests, threaded through every Date.now site; setRateLimitClock is production-guarded; behavior-preserving (no return-shape change; that rework is P19, and ratelimit_db.ts does not exist until P19)
- [x] An in-memory FakeRateLimitStore implementing the type-only RateLimitStore interface ({remaining,resetSeconds}) with the injected clock; mirrors recordSlidingWindowAttempt semantics
- [x] FakeDb (SocialDb-style injected-interface) for characters/leaderboard/reports with in-memory fakes + a type-only-import tsc drift guard that fails the build on signature drift (reports targets moderation_db.ts, where createPlayerReport actually lives)
- [x] A golden-master generator (write-then-compare, no manual-approve) + a separately-tested field-name-driven normalizer with an exported NORMALIZER_PLACEHOLDERS constant (timestamps, ids, tokens, reqId, Date header, expiry seconds, nonces/csrf)
- [x] A parity-harness driver (runParity) running each fixture through BOTH injected dispatchers in-process with per-pass isolation (every limiter bucket incl. the failed-login bucket + clock reset, plus an injected reset hook for the later fresh-ALS/reloaded-config steps)
- [x] Registry-introspection meta-test helpers (route completeness; :id requireOwned presence with operator AND publicRead exclusions)
- [x] A pure loadConfig(env) returning a frozen Config separate from the boot call site (parses the single API_DISPATCH flag; NOT wired into boot, that is P24)
- [x] Create the tests/server/ + tests/server/helpers/ + tests/server/http/ dirs and an index barrel; standardize tests/server/<domain>.test.ts (existing suites NOT converted)

QA:
- [x] Fixes applied
- [x] Tests added
- [x] Dead code removed
- [x] Reviews clean

Notes:
- Shipped server/http/types.ts (TYPE-ONLY, zero runtime emit: RouteDef/RouteMeta/RequireOwned/OwnerScope/Ctx/CtxAccount/Method/Surface/EnvelopeKind/Middleware/Next/RateLimitStore + the Standard-Schema-v1 slot), server/http/config.ts (pure loadConfig), the server/ratelimit.ts clock seam, and tests/server/helpers/{fake_http,fake_ctx,fake_db,fake_ratelimit_store,normalizer,golden,parity,registry_introspect,index}.ts with self-tests, plus tests/server/ratelimit_clock.test.ts and tests/server/http/config.test.ts.
- Orchestration: lead wrote the frozen types.ts, then three parallel Agents (clock+store; fake-http+ctx; FakeDb+config) on disjoint files, then one Agent for golden/normalizer/parity/registry. All against the one frozen contract.
- In-phase reviewers (the two the phase doc requires): privacy-security-review 0 BLOCKING / 0 SHOULD-FIX (3 nits), qa-checklist READY 0 BLOCKING / 2 SHOULD-FIX. Per the standing "apply every finding" directive, ALL were applied: production guard on setRateLimitClock; a meta.publicRead marker so public :id reads are not false-flagged (the Phase 10 exemption); resetAuthFailures added to the parity per-pass isolation (the failed-login bucket was bleeding); normalizer no longer over-masks the generic key 'state'; makeReq lower-cases header names. The golden mkdir/write nit was reviewed as intentional (test-only, author-controlled path), no change.
- Validation: tsc clean; tests/server 15 files / 120 tests; behavior-preservation (woc_balance/wallet_server/discord_server/security/ip_block + ratelimit_clock) 156 tests unchanged; full npm test 582 files / 6115 passed / 11 skipped; build:server/build:env/build green; ci:changed green (only pre-existing ws_auth noExplicitAny warnings). NO DDL, NO ensureSchema change, NO WS wire change, NO src/sim touch.
- QA pass (phase-02-qa.md, 2026-06-30): brief (Explore) + 8-way audit fan-out (4 correctness slices, test-coverage, dead-code, privacy-security-review, qa-checklist) + adversarial verify, then two gap re-runs (the clock-correctness slice degenerated to a stub and the privacy-security agent hit the StructuredOutput retry cap, so both were re-dispatched fresh). All 11 acceptance criteria verified PASS: types.ts type-only (compiles to just `export {};`), the clock seam threads all 5 former Date.now sites with a Date.now default + production guard and changes no return shape, FakeDb drift guard is a real compile-time `satisfies` over the live db.ts/moderation_db.ts signatures, the normalizer masks exactly the 7-token set (look-alike numerics untouched, generic `state` preserved), the parity driver isolates every limiter bucket + clock per pass, registry-introspect excludes operator/admin/publicRead :id routes, and loadConfig is pure/frozen/fail-fast/unwired. Security CONFIRMED: the clock cannot weaken a window in prod (NODE_ENV guard; Dockerfile sets NODE_ENV=production) and loadConfig never logs/leaks DATABASE_URL/TURNSTILE_SECRET/GITHUB_TOKEN and fails closed. 0 BLOCKING, 0 SHOULD-FIX. Per the standing "apply every finding" directive, all 3 in-scope NICE-TO-HAVEs were fixed (commits 54df58b0 named DEFAULT_SITEMAP_LIMIT in fake_db.ts; 6707ee2d dropped the dead updated.length>0 branches in FakeRateLimitStore.hit; 0d08e73b added a dedicated default-clock no-op assertion to ratelimit_clock.test.ts, taking it 6 -> 8 cases). Two security NICE-TO-HAVEs are deferred to their wiring phase (Config returns secrets as plain fields: when a later phase calls loadConfig(process.env) at boot, guard against console.log(config)/error-serialization dumping them, e.g. a redacting toJSON; resetRateLimitClock has no NODE_ENV guard, which is correct since it only restores Date.now). Re-validated: tsc clean; full npm test 582 files / 6117 passed / 11 skipped; build:server/build:env/build green; ci:changed clean (pre-existing ws_auth warnings only).

## Phase 03: Surface re-inventory, content-type classification + characterization/golden corpus

Deliverables:
- [x] Re-derive every endpoint against HEAD by SYMBOL anchor (never line numbers); route-count freshness gate test (tests/server/http/surface_inventory.ts + surface_inventory.test.ts). 106 inventory rows across the four dispatchers + the OPTIONS-204 preflight; the gate reads the four dispatcher SOURCE files and asserts set-equality (75 exact `=== '<path>'` arms + 18 `*Match` :param regex sources), with a vacuous-pass guard, so a route added/removed in source without an inventory edit hard-fails.
- [x] Classify the /api surface into the 5 named content-type classes (content_type_classification.ts): PROBLEM_JSON, HTML (discord/callback ONLY), BINARY (card request body), LEGACY_OKFALSE_405 (perf-report + site-presence), REDIRECT. CORRECTION to the plan: the Discord callback is HTML (a 200 text/html bounce page with client-side location.replace), NOT a 302 REDIRECT; REDIRECT therefore maps to ZERO routes today (defined for taxonomy completeness, asserted unused). Every /api path carries exactly one class; the completeness gate fails on any unclassified /api path. QA CORRECTION: account/email/verify and email/unsubscribe were initially classed HTML but both handlers answer application/json in every branch (the captured email/unsubscribe golden is application/json), so QA reclassified both to PROBLEM_JSON; the HTML class now maps to exactly one /api route, /api/auth/discord/callback.
- [x] Characterization golden corpus (characterization.test.ts + characterization_admin_oauth_internal.test.ts + 57 fixtures under tests/server/fixtures/{main,admin,oauth,internal}) over the four dispatchers, captured by replaying routeHttpRequest (the Phase 1 spine) through the Phase 2 goldenMaster + normalizer. Byte-stable across runs. Covers the contract/error paths (404 unknown-endpoint, 405 method-ownership, 401 auth-before-method, 413 pre-auth oversize, 503 unconfigured, 204 preflight, the 4 leaderboard query-forks, the 4 Discord /api routes, dev-gated /api/perf, both internal secret gates). DB/network-backed SUCCESS bodies are DEFERRED (documented deferral ledgers) to avoid blessing a pool-less-500 or a dynamic-token golden; later phases mock the db and pick these up.
- [x] knownDeviation list seeded (known_deviations.ts + known_deviations.test.ts): 12 entries, each tagged introducedInPhase (4 to 25) or null (by-design, preserved). Test cross-checks every deviation route exists in the inventory, every phase is null or in [4,25], ids are unique, and every listed goldenFixtures path exists on disk.

QA:
- [x] Fixes applied (3 em dashes in a test comment removed; the as-const arrays annotated `readonly T[]` so tsc passes; biome golden-dir ignore added for tests/server/fixtures, mirroring tests/parity/golden)
- [x] Tests added (4 new test files, 73 tests, byte-stable across two runs)
- [x] Dead code removed (N/A: net-new test-only deliverable)
- [x] Reviews clean (privacy-security-review CLEAN: secret gates reject, no token/secret/PII in any fixture, no defect blessed as by-design; qa-checklist READY: freshness gate is not a tautology, no runtime/i18n change, 3 by-design NITs)

Notes:
- ZERO runtime change: the diff is tests/server/http/*.ts + tests/server/fixtures/** + a one-line biome.json golden-dir ignore + these docs. `git diff --name-only` shows no server/ runtime and no src/.
- Validation: `npx tsc --noEmit` clean; the 4 new test files pass (73/73, twice, byte-stable); biome clean on changed files (only pre-existing ws_auth/main noExplicitAny warnings); `npm run build:server` unaffected.
- Surfaced (out of Phase 3 scope, do NOT fix here): (1) Discord callback is HTML not a 302 (corrects the error-model + classification plan; affects Phase 7 mapError and Phase 16). (2) A pre-existing em dash in server/oauth.ts renderDevicePage player-facing HTML (a copy-rule violation in server SOURCE; blocks the GET /oauth/device success golden, deferred; fix when oauth migrates in Phase 18 or as a standalone copy fix). (3) The token-bearing discord callback SUCCESS bounce + the OAuth token-mint/device-authorization SUCCESS bodies embed dynamic tokens the key-name normalizer cannot mask (snake_case device_code/user_code, HTML-embedded token); a candidate Phase 2 normalizer enhancement (snake_case + HTML-body token masking), surfaced not applied.
- By-design NITs (no change warranted, reviewed): the static/SSR createServer prefix routes (/p/*, /avatar/*, /c/*, sitemap) stay on the top-level ladder (Phase 21) outside the 5-class /api scheme, documented in the inventory header; the freshness gate scans the `=== '<path>'` + `*Match` dispatch idioms (every current route uses one), documented; the deferred db/network success-path goldens are by-design (pool-less determinism).

QA VERDICT (Phase 03 QA, 2026-06-30): PASS-WITH-FOLLOWUPS. Brief + 5-way audit fan-out (correctness, test-coverage, dead-code, privacy-security-review, qa-checklist). 1 BLOCKING + 3 SHOULD-FIX + nits, all fixed; deferred follow-ups recorded. No golden blessed a security defect (privacy-security CLEAN on the contract: secret gates reject, anti-enumeration 401 frozen, no token/secret/PII in any fixture body). Fixes landed (commits 69b9129d, 0cd9c3a7, cf4832e3):
  - BLOCKING: account/email/verify + email/unsubscribe were misclassified HTML but emit application/json; reclassified to PROBLEM_JSON (map + inventory rows). Added content_type_consistency.ts, a cross-check that resolves each captured golden to its route's class and asserts the response content-type is consistent, wired through both characterization files so a class/golden content-type contradiction can never pass green again.
  - SHOULD-FIX (de-binarize): surface_inventory.test.ts had three raw NUL (0x00) bytes as dedup-key delimiters, making git/biome/file(1) treat the safety-net test as binary (no line-level diff) and letting biome --write rewrite them to U+FFFD; escaped to U+0000 (identical runtime keys, ASCII source).
  - SHOULD-FIX (freshness granularity): the gate compared path SETS, so a new method on an existing path slipped through; added a method-aware subset guard.
  - SHOULD-FIX (coverage): added a golden for GET /api/account/email/verify (no token -> 400 JSON, pins the JSON content-type); added GET /api/register + POST /api/me/characters wrong-method 404 baselines wired into the planned405BeforeAuth deviation's goldenFixtures (Phase 4 anchor).
  - NIT: captured the /internal/discord/* secret-unset 404 feature-off gate per route (all 8, mirroring the 401 loop); DRYed the admin/oauth/internal goldenMaster boilerplate into one characterize() wrapper.
  - Corpus grew 57 -> 67 fixtures; suite 73 -> 84 tests, byte-stable across two runs; tsc clean, biome clean on changed files, ci:changed exit 0, build:server unaffected; full tests/server 196/196.
  - DEFERRED follow-ups (out of Phase 3 scope, require later infrastructure, flagged by privacy-security-review): (a) the token-bearing SUCCESS goldens (Discord callback bounce, OAuth authorize/device_authorization/token) need the surfaced Phase 2 normalizer enhancement (snake_case device_code/user_code + HTML-embedded session-token masking) BEFORE the Discord/OAuth migrations (Phase 16/18), so the token-delivery contract is frozen pre-migration. (b) The BOLA cross-account 404 and the register taken-username 409 anti-enumeration contracts are asserted only in deviation prose today; capture them as authenticated goldens once a db-mocking harness lands.

## Phase 04: Table router (server/http/router.ts)

Deliverables:
- [x] Map<method,{static:Map,dynamic[]}>, O(1) static match, :param capture with no per-request regex
- [x] 404-vs-405 + Allow, HEAD-for-GET, synthesized OPTIONS from the real method set, single-trailing-slash normalization (convention H), Vary:Origin
- [x] A no-regex-routing guard asserting every pattern is literal segments or a plain :param

QA:
- [x] Fixes applied
- [x] Tests added
- [x] Dead code removed
- [x] Reviews clean

Notes:
- New modules (both PURE, server-only, not wired into the live server until Phase 9; the
  module-first split is the pure helper + its thin consumer):
  - `server/http/path_pattern.ts`: `compilePattern` (the no-regex routing guard), `normalizePath`
    (single trailing slash, root preserved, no internal-slash collapse / no percent-decode / no
    ".." resolution), `matchPattern` (segment-count then string-equality, no per-request regex);
    plus the `HttpMethod` (an ALIAS of the canonical `Method` from server/http/types.ts, not a
    second source of truth), `PatternSegment`, `CompiledPattern` types.
  - `server/http/router.ts`: `createRouter(routes)` over a `Map<HttpMethod,{static:Map,dynamic[]}>`,
    returning the discriminated `MatchResult` union (`matched` with params + `head`,
    `methodNotAllowed` with a sorted Allow, synthesized `options`, `notFound`). HEAD maps to GET;
    OPTIONS is synthesized from the real method set; the Allow set always includes synthesized
    OPTIONS and (when GET is present) HEAD, ordered by a complete `METHOD_ORDER` map.
  - Tests: `tests/server/http/path_pattern.test.ts` + `tests/server/http/router.test.ts` (55 tests).
- The router is a PURE match function: it returns descriptors, never writes a header/response/
  envelope. The 405/404/OPTIONS WRITES + the Vary:Origin header are the Phase 9 dispatcher's job;
  the error bodies are Phase 7's. The honest 405+Allow is default; the anti-enumeration
  404-instead-of-405 override on auth routes is applied by Phase 9 from an explicit list, never here.
- The no-regex guard REJECTS the admin enum-alternation route
  `/admin/api/moderation/accounts/:id/(suspend|unsuspend|ban|unban)` (the only such route in the
  Phase 3 inventory), which is what forces it to restructure to `:param` + schema in Phase 17.
- DECISIONS beyond the literal contract (sound, recorded for Phase 9): registering HEAD/OPTIONS is
  rejected (they are synthesized, so a HEAD-only route is intentionally inexpressible; the inventory
  has none); the duplicate guard rejects same-SHAPE patterns (so `/a/:x` vs `/a/:y` throw, not just
  textual dups), and reserved param names (`__proto__`/`constructor`/`prototype`) are rejected at
  compile time.
- Validation green: tsc clean; the two http files 55 tests pass; full `npm test` 611 files / 6411
  pass; build:env/build:server/build all exit 0; Biome on changed files clean; ASCII-clean (no
  em/en dashes, no emojis). Reviewers (privacy-security-review, qa-checklist, fresh coverage
  subagent): 0 BLOCKING; all SHOULD-FIX + NIT findings applied (per the apply-all-findings rule).
  Forward/cross-seam notes recorded in state.md for Phase 9. Next: Phase 04 QA (phase-04-qa.md).

QA (phase-04-qa.md) verdict: PASS. 0 BLOCKING. Audited by a context Explore agent + 4 parallel
reviewers (correctness, test-coverage, dead-code, privacy-security-review): correctness 0 findings
(all 21 acceptance criteria verified against the real code), dead-code 0 findings, privacy-security
PASS (routing-bypass safe-by-contract, 405+Allow Phase 9-overridable, ReDoS-safe by construction,
no prototype-pollution path), test-coverage found 1 SHOULD-FIX + 3 NIT coverage gaps (no code
defects). All applied (apply-all-findings rule):
- SHOULD-FIX (coverage): a 405 reached through a dynamic/param route under a wrong real method was
  asserted nowhere (every methodNotAllowed test used a static path). Added the canonical
  wrong-method-on-a-resource test (`POST /api/characters/42` with GET+DELETE `:id` -> 405 Allow
  `[GET, HEAD, DELETE, OPTIONS]`).
- NIT (coverage): multi-param capture (`/a/:foo/b/:bar` -> `{foo,bar}`); PUT and PATCH positions in
  METHOD_ORDER (never exercised before) pinned via a GET/PUT/PATCH/DELETE Allow assertion; a
  structural server-only PURITY test (criterion 16) over both source files asserting they import
  nothing parent-relative (`../`) or `node:` (the no-req/res half is tsc-guaranteed by the
  signatures).
- HARDENING (privacy NIT, defense-in-depth): `matchPattern` now builds the captured-params bag with
  `Object.create(null)` so the returned params object has no inherited `Object.prototype` keys (the
  real prototype-pollution path was already closed by the compile-time reserved-name guard). Pinned
  by a null-prototype assertion. `toEqual` is prototype-insensitive, so existing capture assertions
  are unaffected.
- DEFERRED to Phase 9 (privacy NIT, not a router defect): a catch-all leading-`:param` dynamic route
  registered before a specific route could shadow a route carrying a `requireOwned` BOLA loader
  (cross-shape dynamic overlaps resolve first-registered, by design). Recorded as a Phase 9 registry
  obligation in state.md (order specific dynamic routes first; add an introspection check that no
  overlapping dynamic shape leaves a `requireOwned` route shadowed by a non-owned one).
- Re-validation after the 5 added tests + the 1-line hardening: tsc clean; the two http files 60
  tests pass; full `npm test` 611 files / 6420 pass / 11 skip; build:env/build:server/build all exit
  0; Biome on the 3 changed files clean; ASCII-clean. Next: Phase 05 (onion compose + request
  context, phase-05-onion-context.md).

## Phase 05: Onion compose + request context (compose.ts + context.ts)

Deliverables:
- [x] compose(Mw[]) recursive dispatch with a double-next guard
- [x] Ctx type + buildContext (url, query, params, ip via requestIp(), reqId, body?, account?)
- [x] An AsyncLocalStorage carrier for reqId
- [x] An outermost wrapper contract: the top-level compose(ctx) call is wrapped to guarantee exactly one idempotent response on both the resolve and throw paths (raw node:http does not auto-respond)

QA:
- [x] Fixes applied
- [x] Tests added
- [x] Dead code removed
- [x] Reviews clean

Notes:
- New modules (both server-only, NOT wired into the live server until Phase 9; no
  `server/http/index.ts` barrel created, Phase 9 owns it):
  - `server/http/compose.ts`: `compose(stack)` (the canonical Koa onion dispatch with a
    `lastIndex`-cursor double-next guard that rejects with `'next() called multiple times'`,
    the exact string the Phase 2 `nextGuard` uses), `runOnion(ctx, stack)` (the OUTERMOST
    wrapper: runs the composed stack inside `runWithReqId(ctx.reqId, ...)`, then guarantees
    exactly one response), and `respondOnce(res, status, headers?, body?)` (the
    headersSent/writableEnded-guarded idempotent low-level sender, exported for reuse). It
    imports `Ctx/Middleware/Next` from `./types` and `runWithReqId` from `./context`; it does
    NOT redefine or re-export the frozen types, and there is no import cycle (context never
    imports compose).
  - `server/http/context.ts`: `buildContext(req, res, match)` producing the frozen `Ctx`
    (`Ctx` has NO `route` field, so the match is read ONLY for `params`); reuses
    `ratelimit.requestIp` for `ctx.ip` (never re-derives IP); `query` and the non-matched
    `params` are built on `Object.create(null)`. Plus the reqId carrier:
    `reqIdStorage` (AsyncLocalStorage<string>), `newReqId` (crypto.randomUUID, a server-side
    id, NOT sim randomness), `runWithReqId`, `currentReqId`.
  - Tests: `tests/server/http/compose.test.ts` (17) + `tests/server/http/context.test.ts`
    (20). The Phase 2 `tests/server/helpers/fake_ctx.ts` was left UNTOUCHED (it already
    returns a valid frozen Ctx with deterministic test defaults; a context test asserts
    `buildContext` and `fakeCtx` produce the same own-key set rather than re-pointing the helper).
- LOAD-BEARING: `compose()` neither responds nor catches. Raw node:http hangs the socket on an
  uncaught throw, so `runOnion`'s one-response wrapper is mandatory. The fallbacks emit NO body
  and NO internal detail (no stack/SQL/table/English): the catch arm uses `catch {` with no
  binding so the thrown value is never read. The real RFC 9457 envelope is Phase 7; `withErrors`
  is Phase 8 and sits INSIDE this wrapper later. Fallback statuses are named consts:
  resolve-with-no-response = 404 (a distinct structural fallback), uncaught-throw = 500; both
  carry `X-Request-Id` from `ctx.reqId` (the echo-on-every-response middleware is Phase 8/23).
- Validation green: tsc clean; the two http files 37 tests pass; `npm run ci:changed` exit 0
  (no warnings on the 4 files); build:env/build:server/build all exit 0; full `npm test` green;
  ASCII-clean (no em/en dashes, no emojis). Reviewers (privacy-security-review, qa-checklist,
  fresh coverage subagent): 0 BLOCKING, 0 SHOULD-FIX-correctness; all findings applied (apply-all
  rule), see the QA section. Next: Phase 05 QA (phase-05-qa.md).

QA (reviewers) verdict: PASS. 0 BLOCKING. Audited by privacy-security-review + qa-checklist + a
fresh coverage subagent (each told to report COVERAGE, not filter). qa-checklist and coverage
returned PASS with every acceptance criterion met by a regression-sensitive test; privacy returned
2 SHOULD-FIX (forward-looking) + nits. All applied (apply-all-findings rule):
- SHOULD-FIX (privacy, host-injection): `new URL(req.url, base)` adopts a CLIENT-supplied host on
  an absolute-form target (`GET http://evil.com/api/foo`), seeding a foreign authority into the
  frozen `ctx.url` that a later phase could trust for a redirect Location / same-origin check.
  Fixed with a `buildUrl(target)` helper that rebuilds the URL from path + search ONLY, pinning the
  authority to the placeholder. Pinned by a new test (absolute-form -> `ctx.url.host` stays localhost).
- SHOULD-FIX (privacy, totality): `new URL` throws on a malformed target, and `buildContext` runs
  OUTSIDE `runOnion`'s safety net, so a throw there would hang the socket once Phase 9 wires it.
  `buildUrl` now catches and falls back to the root path, keeping `buildContext` total. Pinned by a
  malformed-target (`http://`) test asserting no throw.
- NIT (privacy, totality) + the qa/coverage partial-response observation: the catch-path
  `respondOnce` was itself unguarded, and a middleware that committed headers but never ended would
  hang the socket. Replaced both inline fallbacks with a `finalizeResponse(ctx, status)` helper that
  (1) no-ops when already ended, (2) sends the bare fallback when nothing was committed, (3) `end()`s
  a headers-committed-but-unended response to close the socket, and swallows a throw from an unusable
  (destroyed-socket) response so `runOnion` never throws out of its own net. Two new tests assert the
  socket is ended on both the throw and resolve partial paths.
- NIT (qa/coverage, coverage): added an empty-stack `compose([])` test and a `respondOnce` Buffer-body
  test; named the `'GET'`/`'/'` buildContext default literals (`DEFAULT_METHOD`/`DEFAULT_REQUEST_PATH`).
- KEPT with rationale: the 404 no-response fallback (the spec deliberately calls it a distinct "bare
  fallback", and both reviewers judged 404 defensible / 500-vs-404 a non-blocking discussion item);
  the `(req.method ?? 'GET').toUpperCase() as Method` cast (the router is the method gate before Phase
  9 wiring; node delivers methods uppercase; documented in a comment, no actionable improvement without
  unfreezing `Method`).
- Re-validation after the fixes + 5 added tests: tsc clean; the two http files 37 tests pass; full
  `npm test` green; build:env/build:server/build all exit 0; Biome on the 4 changed files clean;
  ASCII-clean. Next: Phase 05 QA (phase-05-qa.md).

QA (phase-05-qa.md) verdict: PASS-WITH-FOLLOWUPS-RESOLVED. Audited by a context Explore pass + 4
parallel auditors (correctness, coverage, dead-code, privacy-security-review) each adversarially
re-verified by an independent skeptic (9 raw -> 6 confirmed, 1 refuted). 1 BLOCKING defect (counted
twice, code + masking test), 2 SHOULD-FIX, 2 NIT, all applied (apply-all-findings rule):
- BLOCKING (privacy, buildUrl): the in-phase host-injection fix was INCOMPLETE. Rebuilding via
  `new URL(parsed.pathname + parsed.search, PLACEHOLDER_ORIGIN)` still adopts a CLIENT host for a
  plain origin-form target whose normalized path begins with `//`: `/..//evil.com` collapses to
  `//evil.com`, which the second `new URL` re-reads as a protocol-relative AUTHORITY, so
  `ctx.url.host` becomes `evil.com` (and `/..//evil.com:8443/x` -> `evil.com:8443`). Verified
  empirically. The absolute-form-only pinning test masked it (its path was the safe single-slash
  `/api/foo`). Fixed by ASSIGNING `url.pathname`/`url.search` onto a fresh fixed-authority `URL`
  object (the setters cannot move the authority); host stays `localhost` for every `//`, backslash,
  encoded-slash, and userinfo vector tested. Pinned by two new regression tests that fail on the old code.
- SHOULD-FIX (coverage, compose sync-throw): the existing sync-throw test put the thrower at index 1
  behind an async parent, so it passed even with compose's entry-frame try/catch removed; its inline
  comment claimed otherwise. Corrected the comment and added a test that a FIRST middleware throwing
  synchronously yields a rejected promise, not a synchronous throw (the only case that exercises the guard).
- SHOULD-FIX (coverage, finalizeResponse net): the catch-swallow branch ("runOnion must never throw
  out of its net") was dead across the suite. Added a test injecting a res whose writeHead/end throw
  while writableEnded is false (a destroyed socket); runOnion must still resolve.
- NIT (coverage): added a clean short-circuit test (a middleware resolves WITHOUT calling next();
  downstream never runs) and a runOnion test where an inner middleware ends the response and an outer
  one then throws (the writableEnded early-return on the throw path keeps the 200, no 500 clobber).
- NIT (dead-code, comments): reconciled the Phase 7 vs Phase 8 attribution in compose.ts (the RFC 9457
  envelope and codes are Phase 7; the withErrors middleware that emits them is Phase 8).
- REFUTED: "double-next is only exercised from the outermost frame" - the guard (`i <= lastIndex`,
  one monotonic closure var) is frame-agnostic, so a deeper-frame case would re-assert identical logic.
- Re-validation: tsc clean; the two http files 43 tests pass (was 37, +6); full `npm test` green;
  build:env/build:server/build all exit 0; Biome on the 4 changed files clean; ASCII-clean.
  Next: Phase 06 (typed schema validator, phase-06-schema-validator.md).

## Phase 06: Typed schema validator (schema.ts)

Deliverables:
- [x] object()/str()/num()/bool()/enum_()/optional() decoders conforming type-only to the Standard Schema v1 ~standard shape (imported from the frozen types.ts, NOT a new standard_schema.ts)
- [x] All-issues-in-one-pass collection yielding issues[]{pointer,code,params} as stable CODES, never English
- [x] Infer<typeof S> so handler input types derive from the schema (no parallel interface)
- [x] Typed params AND query (a :id cannot reach a DB call as NaN; page/pageSize bounded once)

QA:
- [x] Fixes applied (3 SHOULD-FIX + the actionable NITs from the correctness/security review, all applied)
- [x] Tests added (37 in tests/server/http/schema.test.ts: runtime + tsc-checked type-level)
- [x] Dead code removed (none introduced; module is the minimal combinator set)
- [x] Reviews clean (privacy-security 0/0, qa-checklist 0/0, adversarial-correctness 0 BLOCKING)
- [x] Dedicated QA gate (phase-06-qa.md) PASS: 0 BLOCKING, 1 SHOULD-FIX + 3 NIT all applied (all test-coverage)

Notes:
DONE + QA DONE (2026-06-30). New module `server/http/schema.ts` (150 code lines, under the ~150 cap;
zero new deps) + tests. Surface: `Issue {pointer, code, params?}`, `DecodeResult<T>` (`{ok,value}` |
`{ok:false,issues}`), `Schema<T> extends StandardSchemaV1<unknown,T>`, `Infer<S>`; combinators
`object/str/num/bool/enum_/optional(schema, default?)`; stable codes `type|required|min|max|int|
minLength|maxLength|enum`. decode() collects ALL field issues in one pass; `object()` reads ONLY
declared keys (via `Object.hasOwn`) into a null-proto object, so an input `__proto__`/`constructor`
key cannot pollute a prototype. `num()`/`bool()` coerce strings (params/query arrive as strings).
TWO doc-vs-code reconciliations (the phase doc text was stale; both match state.md's canonical plan):
(a) NO new `server/http/standard_schema.ts` - Standard Schema v1 is already vendored in the
Phase-2-frozen `server/http/types.ts` ("the SINGLE home ... Phases 4 to 9 import, never redefine"),
so schema.ts IMPORTS `StandardSchemaV1`/`StandardSchemaProps`/`StandardSchemaResult`/
`StandardSchemaIssue` from `./types`. (b) NO `server/http/index.ts` barrel added - none exists; the
barrel is the Phase 09 deliverable, so schema.ts is consumed by direct extensionless imports.
The `~standard` conformance is type-only; the runtime `~standard.validate` is a thin sync adapter
over decode() that still emits CODES (`message = issue.code`, never English).

Review verdict: 3 reviewers (privacy-security-review, qa-checklist, adversarial-correctness), 0
BLOCKING. The correctness pass found 3 SHOULD-FIX, all applied as a deliberate input-boundary
HARDENING beyond the minimal contract (decided in QA, documented for Phase 10+ callers):
- `num()` string coercion is now CANONICAL DECIMAL only (a `DECIMAL` regex, anchored/ReDoS-safe):
  hex/octal/binary/scientific strings (`'0x10'`->was 16, `'1e3'`->was 1000) are rejected with code
  `type`, so a string `:id` never decodes to a surprising value. Still contract-compatible ("coerce
  a string, reject NaN"); body numbers (real `number`) are unaffected.
- `num({ int })` now requires `Number.isSafeInteger` (was `isInteger`), so two distinct id strings
  past 2^53 can no longer alias to the same number (rejected with code `int`).
- `optional(schema, default)` CLONES an object/array default per decode (`structuredClone` for a
  mutable default), so a mutable default is never shared by reference across requests.
Plus NITs applied: `object()` output is null-proto (`Object.create(null)`, defense-in-depth matching
the spine's params/query idiom); `bool()` trims string input for parity with `num()`; and added
coverage (falsy bounds `min:0`/`max:0`/`maxLength:0`, `-Infinity`, non-decimal rejection, both
`int`+`min` collected in one pass, present-but-invalid optional inside an object, a nested +
`optional(object())` Infer assertion, case-sensitive enum, the object-default non-aliasing proof,
and an explicit-pointer decode). Deferred (correctly OUT of scope): code->HTTP-status + problem+json
(P7), the `withBody`/validate middleware that calls decode() (P8), RouteDef.schema wiring + registry
(P9), concrete page/pageSize bounds + the {items,...} envelope (P10), the client i18n matcher (P22).
Validation: tsc/biome(ci:changed)/build:server all green; `tests/server/http/` 229 pass (schema 33);
full ASCII-clean.

Phase 06 QA gate (phase-06-qa.md, dedicated adversarial pass, 2026-06-30): PASS. A 4-auditor fan-out
(correctness, test-coverage, dead-code, privacy-security) plus per-finding adversarial verify found
0 BLOCKING and CONFIRMED 1 SHOULD-FIX + 3 NIT, all TEST-COVERAGE gaps; the implementation itself was
re-verified defect-free (no schema.ts change). The correctness and security auditors confirmed every
STEP 5 criterion against the real code; 3 further findings were REFUTED on verification (a redundant
params-survival assertion, and two subjective dead-code simplifications: the makeDefault-vs-base-decode
duplication and the one-pass-return rule-of-three, both judged non-defects not worth churning correct
code). The 4 confirmed test additions (commit, +4 tests -> schema 37):
- SHOULD-FIX: object()'s makeDefault() clone path for an absent optional field is a SECOND clone site
  separate from optional().decode(undefined); only the latter was tested, so dropping the object-path
  clone (schema.ts:217) would pass all 33 tests yet share one mutable default across decodes (per-request
  cross-mutation bleed). Added a mutable-default non-aliasing test through the object path.
- NIT: assert the null-prototype output construction (Object.getPrototypeOf === null), which no test
  pinned (a refactor to a plain `{}` literal would still pass, since declared-keys-only already neutralizes
  __proto__ input).
- NIT: assert `~standard.validate` converts a MULTI-segment pointer to a nested path array
  (['parent','child']); only [] and ['id'] were covered.
- NIT: prove the second clause of the pollution invariant (a SHAPE that itself declares a `__proto__`
  key, via a computed key) cannot pollute Object.prototype.
Re-validation after the test hardening: tsc/biome(ci:changed)/build:server all green; `tests/server/http/`
233 pass (schema 37); full ASCII-clean. Next: Phase 07 (RFC 9457 error model + error_codes catalog,
phase-07-error-model.md).

## Phase 07: RFC 9457 error model + per-surface serializers + error_codes catalog

Deliverables:
- [x] HttpError(status,code,params?,headers?) + toAppError: malformed-JSON->400, validation->422 (ALL issues one pass), missing/invalid token->401(+WWW-Authenticate), no-entitlement->403, over-cap->413, unique-violation(23505)->409, rate-limited->429(+Retry-After), unknown->onUnexpected-500 with no stack/SQL/table text
- [x] Per-SURFACE serializer selection (problem+json / RFC 6749 oauth / admin {success,data,error} / HTML-error / redirect 302 / binary text/plain / ok_false 405), by the route error-surface tag NOT per-prefix, resolving the non-JSON /api classification
- [x] error_codes.ts as the single as-const source of truth, deep-frozen (domain.reason) + param keys append-only per AIP-193, reusing the existing userFacingApiError vocabulary

QA:
- [x] Fixes applied (2 SHOULD-FIX + the actionable NITs from privacy-security-review + qa-checklist, all applied; 1 nit declined with documented rationale)
- [x] Tests added (91 across the 3 files: 9 error_codes + 46 errors + 36 leak; was 85, +6 in review hardening)
- [x] Dead code removed (folded the duplicated isUnexpected() branch enumeration into a single AppError.unexpected flag)
- [x] Reviews clean (privacy-security-review 0 BLOCKING, qa-checklist READY/0 BLOCKING)

Notes:
DONE + QA DONE (2026-06-30). Two new spine modules, zero new deps, wires NO routes (Phase 8 calls
mapError; Phase 22 localizes the codes). `server/http/error_codes.ts` (140 lines): a deep-frozen
`as const` ERROR_CODES catalog, `ErrorCode = keyof typeof ERROR_CODES`, 48 codes (9 structural + 39
harvested). `server/http/errors.ts` (392 lines): `HttpError(status, code, params?, headers?)`,
`toAppError(err): AppError` (the exhaustive status table), `normalizeSurface(EnvelopeKind|ErrorSurface)`,
seven per-surface serializers, `mapError(err, ctx, opts?): {status, headers, contentType, body}` that
RETURNS the shape (does not write ctx.res). Orchestrated as 1 Explore (context) + 3 parallel writers
(A catalog, B errors, C leak test) against a locked contract, then 2 reviewers.

Key facts that corrected the phase brief (from the Explore pass): (a) Ctx has NO `route`/`envelope`
field (Phase-5-frozen), so mapError reads the surface from `opts.surface` (the route `EnvelopeKind`
tag), defaulting to 'problem'; Phase 8's withErrors will pass it from the matched RouteDef. (b)
schema.ts has NO ValidationError class and decode() never throws; it returns `{ok,value}|{ok:false,
issues:Issue[]}`, so a 422 normally arrives as an HttpError Phase 8 builds, and toAppError also
defensively recognizes a raw `{ok:false, issues}`. (c) the Discord callback is HTML not a 302, so the
REDIRECT class maps to ZERO live routes today (the 'redirect' serializer is defined for completeness).
(d) the card 413 is application/json + Connection:close today; the 'binary' serializer is the new
minimal text/plain form (binary is NOT in the stay-as-today set).

Seeded codes: the 9 structural (validation.failed[issues], json.malformed, auth.token_missing,
auth.token_invalid, auth.forbidden, body.too_large[maxBytes], db.conflict, rate_limit.exceeded
[retryAfterSeconds], internal.error) + 39 harvested domain.reason codes reconciled 1:1 to the existing
userFacingApiError identities (auth.*, account.*, character.*, moderation.*, email.*, two_factor.*).
The ONLY parametric harvested code is moderation.suspended_until[date]. Each harvested code carries an
`// identity:` comment naming its English source string for the Phase 22 client matcher.

Review verdict: privacy-security-review 0 BLOCKING (the 500-no-leak hard gate holds on all 7 surfaces;
redirect Location is a fixed encoded /error?code=; no open-redirect; auth/status/header semantics
correct). qa-checklist READY, 0 BLOCKING. Applied: (1) SHOULD-FIX serializeProblem now spreads
`...params` FIRST so an RFC 9457 reserved member (notably `code`, the localization key) can never be
shadowed by a future catalog param; (2) SHOULD-FIX documented the intentional breadth of the
SyntaxError->400 arm + the Phase 8 narrowing plan (withBody rethrows HttpError(400) so stray internal
SyntaxErrors fall to the 500+onUnexpected branch); (3) NIT unified the unexpected-500 decision into a
single AppError.unexpected flag (deleted isUnexpected, removing the lockstep duplication); (4) NIT
added tests (params-in-body maxBytes/retryAfterSeconds/date, the reserved-key shadow regression,
case-insensitive header non-overwrite, non-auth-401 WWW-Authenticate skip, the unexpected-flag
semantics). DECLINED with rationale: broadening WWW-Authenticate to all 401s (privacy nit) - it is
applied surface-agnostically in toAppError and a Bearer challenge is only meaningful on the bearer
API surface, not on oauth/admin 401s; a route needing another RFC 7235 challenge sets its own header.

Validation: tsc clean; the 3 new files 91 tests pass; full tests/server/http 324 pass (was 318);
S3 guard (localization_fixes.test.ts) 27 pass/3 skip (unchanged; server matcher untouched, Phase 22
owns the REST code-parity guard); build:server exit 0; Biome clean on the 5 changed files; ci:changed
exit 0; ASCII-clean (no em/en dash, emoji, .only, debugger). Deferrals: withErrors middleware -> P8;
client userFacingApiError extension + apiError.* catalog + per-surface code-parity Vitest -> P22; the
real Retry-After VALUE sourcing from the limiter -> P19; the em-dash rate-limit string fix -> P13; the
structured logger + /metrics -> P23. Next: Phase 07 QA (phase-07-qa.md).

## Phase 08: Core middleware set + metric/log hook seam + thin rateLimit adapter

Deliverables:
- [ ] withErrors (outermost), requestId+ALS, withCors(class), withBody(maxBytes) mapping overflow->413/bad-json->400 preserving the card pre-auth Content-Length 413 short-circuit, PLUS a withRawBody/binary variant for the card route
- [ ] requireAccount({scope}) as the one bearer resolver modeling at least read/active/full scopes, applying the ban/moderation+scope gate uniformly
- [ ] A THIN rateLimit(policy) adapter over today's existing limiter booleans (deep two-tier rework deferred to P19)
- [ ] The per-route metric + access-log hook behind an INJECTABLE no-op sink (collection point must land now)
- [ ] Always-drain-body on early reject; clientError handler at the top-level createServer setup (no req/res, destroy the socket)

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 09: Registry + dispatcher-in-front (per-path delegate) + dual-path parity harness + top-level CORS wrapper

Deliverables:
- [ ] registry.ts spreading domain route tables into one lookup + http/index.ts barrel
- [ ] New dispatcher in front of old handleApi; un-migrated paths delegate per-path to the old ladder unchanged; reproduce the createServer prefix order and the non-awaited void semantics exactly
- [ ] Keep CORS/OPTIONS as a top-level wrapper covering both old and new paths
- [ ] A parity harness diffing each P3 fixture through old vs new (status, body, contracted headers), weighting error and 404-vs-405 paths heaviest, blocking on any undocumented diff
- [ ] A registry-completeness test diffing the old-ladder path set against the new-router path set, hard-failing on any old path absent from the new router (run on every rebase)

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 10: Migrate public reads (server/leaderboard.ts)

Deliverables:
- [ ] Port /api/leaderboard (incl. ?board=guilds, legacy ?limit=N, ?scope), /api/arena/leaderboard, /api/releases, /api/project-stats, /api/search, /api/realms, /api/public/characters/:id/sheet, dev-gated /api/perf as RouteDefs
- [ ] Typed page/pageSize query decoders + the {items,page,pageCount,total,pageSize} envelope (convention B); decide explicitly whether it applies to the guild board and legacy single-page shape
- [ ] Labeled-behavioral /api/status trim to {ok,realm,players_online}
- [ ] Apply the one bearer resolver to /api/realms (anonymous-friendly when no token) and /api/search, closing their authz gap

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 11: Migrate auth (register/login/native-attestation)

Deliverables:
- [ ] Port /api/register, /api/login, /api/native-attestation/challenge
- [ ] passesTurnstile as a per-route POST-body middleware after withBody, scoped to register+login (not a global prologue)
- [ ] Preserve authThrottled as a HANDLER-level check (per-username, failed-only, clears on success, 15m/10-fail)
- [ ] Keep the deliberate anti-enumeration 404 on register/login as a documented knownDeviation

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 12: Migrate character ownership + BOLA seam (server/characters.ts)

Deliverables:
- [ ] Port /api/me/characters, /api/characters (GET/POST), /api/characters/:id (DELETE), /rename, /takeover, /standing, /sheet with typed :id params
- [ ] requireOwnedCharacter loader populating ctx.character via an account-scoped query + a deny-by-default coverage test that every account-owned :id route resolves through an account-scoped loader (admin operator routes excluded)
- [ ] Labeled-behavioral NEW limiters character.create/rename/delete/takeover as asserted knownDeviations
- [ ] 403-vs-404 denial applied per the locked decision (404 for player-owned objects, 403 for admin/operator-scoped routes)

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 13: Migrate account portal (server/account.ts) + em-dash fix

Deliverables:
- [ ] Port account/password/logout/email(+change/verify)/deactivate/export/marketing/2fa(setup/enable/disable)/companion-token/email-unsubscribe (classify unsubscribe as HTML) onto thin Ctx handlers
- [ ] Labeled-behavioral em-dash rate-limit string fix at the re-anchored sites (now 658/664/733/748) AND the matching userFacingApiError change in src/main.ts in the SAME change (prefix unchanged so startsWith still resolves)
- [ ] Fix the operator-facing em dashes in src/admin/i18n.locales/en_CA.ts + its resolved copy

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 14: Migrate wallet + cards (server/wallet.ts)

Deliverables:
- [ ] Port /api/wallet/link/challenge, /api/wallet/link (POST/DELETE), /api/wallet (GET), /api/woc/balance, /api/card (via withRawBody), /api/referrals
- [ ] Preserve keyBy:'ip+account' ordering (account known only after the DB token lookup) and the card pre-auth byte-cap short-circuit + Connection:close
- [ ] Give the previously-unmatched 'rate limited' responses (wallet.ts:39/62, main.ts:1266/1285) stable codes

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 15: Migrate reports + telemetry + misc (server/reports.ts)

Deliverables:
- [ ] Port /api/reports (NEW reports.create per-account limiter, labeled behavioral), /api/bug-reports, /api/perf-report (PRESERVE its 200-not-429 by-design response), /api/site-presence
- [ ] Route bug-report/perf-report through their existing *_db limiters under the policy table
- [ ] Preserve perf_report's 405 and site_presence's 405 ownership through the seam (knownDeviations); characterize the pre-prologue early-return routes whose position changes under the table router

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 16: Migrate Discord family (server/discord.ts), net-new since SPEC

Deliverables:
- [ ] Port /api/auth/discord/start, /api/auth/discord/callback (HTML bounce, not a 302, classified non-JSON), /api/discord (GET status / DELETE unlink) onto RouteDefs; decide whether to wire the orphaned handleSwagClaim
- [ ] Add a discord.* ip+account policy to POLICIES and the discord error codes to the catalog + client matcher
- [ ] Carry forward the isIpBlocked + turnstile parity gap from prior Discord reviews so ported endpoints do not skip those checks
- [ ] Decide whether wiring the unwired DISCORD_SCHEMA into ensureSchema is in scope here or left to PR #1075

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 17: Migrate Admin API onto the shared seam (server/admin.ts)

Deliverables:
- [ ] Convert handleAdminApi branches into RouteDefs KEEPING the {success,data,error} envelope and the frozen page/limit pagination contract (NOT page/pageSize)
- [ ] Restructure admin enum-segment regex routes (suspend|unsuspend|ban|unban) to :param + schema-validated enum to satisfy the no-regex-routing guard
- [ ] Give admin moderation :id routes an admin-scope loader excluded from the account-owner BOLA clause
- [ ] Keep admin.login on its own per-policy limiter store

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 18: Migrate OAuth JSON + Internal onto the shared seam (oauth.ts + internal.ts)

Deliverables:
- [ ] Port /oauth/token, /oauth/revoke, /oauth/device_authorization, authorize-POST, device-POST KEEPING RFC 6749 {error,error_description}
- [ ] Model OAuth as mixed HTML+JSON: the GET authorize/device pages stay on the top-level ladder with the thin security-header subset, only POST JSON gets the RFC 6749 envelope
- [ ] Port the secret-gated /internal endpoints (restart-countdown + the 8 /internal/discord/* bot-channel endpoints) preserving their secret gate

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 19: Two-tier rate limiter + ratelimit_db (cross-cutting, deep)

Deliverables:
- [ ] Rework the limiters (rateLimited, recordSlidingWindowAttempt) from boolean to {remaining,resetSeconds} (touches every limiter; uses the P2 clock seam)
- [ ] ratelimit_db.ts: global-keyed single-statement atomic UPSERT tier-2 backstop with idempotent DDL; ADD RATELIMIT_SCHEMA to the ensureSchema statement list under pg_advisory_xact_lock (the DISCORD_SCHEMA trap); tier-1 in-memory IP gate runs first
- [ ] respond429 emitting Retry-After + draft-11 RateLimit/RateLimit-Policy structured-field headers (q/w/r/t, pinned to a draft version in a comment); per-policy algorithm; swap POLICIES to the two-tier resolver with values DERIVING from existing named constants
- [ ] Add the discord.* policy and the new character/reports policies to the table

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 20: World Market realm-scope fix + partitioned backfill (separate persistence PR)

Deliverables:
- [ ] Realm-scope the world_state 'market' key at BOTH write sites in lockstep (the saveCharacterAndMarketState escrow txn AND saveWorldState) plus the read (loadMarketState); anchor on function names, not the stale lines
- [ ] A backfill PARTITIONING the existing global blob by each seller character's realm, idempotent under the advisory lock, with a boot-ordering gate before the first new-key write
- [ ] A dry-run + escrow-sum/row-count verification and a documented data-rollback

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 21: Security headers top-level wrapper + Content-Type/Origin enforcement

Deliverables:
- [ ] withSecurityHeaders via a TOP-LEVEL wrapper covering serveStatic, /c/ SSR, /p/ card, /avatar, sitemap, OAuth GET pages AND the route onion: nosniff, Referrer-Policy, Permissions-Policy deny-all, HSTS in prod, COOP/CORP same-origin, frame-ancestors/X-Frame-Options on OAuth, no-store on auth/token, strip Server/X-Powered-By; explicitly NO COEP:require-corp
- [ ] Enforce Content-Type: application/json on /api JSON bodies (415) in LOG-ONLY mode first, exempting binary/HTML/redirect routes, until the Capacitor native client is confirmed
- [ ] A cheap Origin/Sec-Fetch-Site check on mutating endpoints (bearer-only, no cookies)

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 22: REST i18n matcher + per-surface code-parity guard

Deliverables:
- [ ] Extend userFacingApiError to look up emitted codes DIRECTLY in the client catalog instead of reverse-matching English prose; port parametric cases (suspended-until {date}, the {seconds} rate-limit families) to {code,params}; preserve its dual REST + WS-disconnect-reason role
- [ ] Add apiError.* English catalog entries and wire them into client i18n; params formatted client-side via formatNumber/formatDuration/Intl
- [ ] A per-surface code-parity Vitest asserting every server-emitted code resolves to a client entry in every locale, append-only frozen, PLUS coverage for the ~30-45 EXISTING REST strings (currently unguarded; S3 scans only game.ts) and the new Discord/guild codes

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 23: Structured logging + /metrics exporter + drain-aware health

Deliverables:
- [ ] A pino-shaped logger facade replacing the ~70 raw console.* calls on the request path, with secret/PII redaction (Authorization/bearer 64-hex/password/cookie/OAuth-code/TOTP/wallet-key); structured access line + X-Request-Id echo on every response via the ALS reqId reaching db.ts/domain fns
- [ ] A Prometheus /metrics exporter (prom-client, the one weighed dependency) emitting the RED request-layer catalog with bounded cardinality (route = :param template, never concrete path)
- [ ] /livez + /readyz with /readyz reporting NOT-ready during the SIGTERM drain

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 24: Validated config + server timeouts + no-magic-values consolidation

Deliverables:
- [ ] A validated fail-fast config read ONCE at boot via the pure loadConfig(env) from P2 (HSTS-in-prod, REQUIRE_WEB_LOGIN, realm/native-app origins, limiter DSN, the dispatch flag), replacing scattered process.env reads; log the active dispatch path at boot and alert if the old path is active in prod
- [ ] Set requestTimeout/headersTimeout/keepAliveTimeout/maxHeaderSize in startServer() with chosen named-constant values mindful of the WS upgrade handshake and the 1 MB card upload
- [ ] Consolidate every tunable into named constants with unit + comment; POLICIES values DERIVE from existing constants
- [ ] Add the perf/tick-jitter acceptance gate (pipeline adds < X ms p99, tick p95 stays under 0.8 x DT)

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:

## Phase 25: Docs + new:endpoint scaffold + flag-default flip

Deliverables:
- [ ] Update server/CLAUDE.md (pipeline model + graduated Adding-an-endpoint recipe + error-localization rule + the injected-FakeDb test recipe over the pg-mock idiom), root CLAUDE.md (the server/http seam), new server/http/CLAUDE.md, i18n docs (apiError.* domain)
- [ ] npm run new:endpoint scaffold emitting RouteDef stub + typed schema + paired error code + English catalog entry + a paired FakeDb-based copy-from TEST file, auto-attaching requireOwned* on :id routes
- [ ] Flip the env-flag default to the new path keeping the old ladders behind the flag; designate one early migration commit as the canonical add-one-authenticated-endpoint example
- [ ] Name the old-ladder deletion exit criteria (metric gate + owner) for the next-release follow-up PR

QA:
- [ ] Fixes applied
- [ ] Tests added
- [ ] Dead code removed
- [ ] Reviews clean

Notes:
