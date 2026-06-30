# API Pipeline: cross-phase state (the cheat sheet)

Authoritative quick-reference for the `docs/api-pipeline/` packet. Every phase file reads
this first in its Explore step. Source of truth for the locked decisions is the canonical
block (transcribed below) and the synthesis. When a phase file disagrees with this file,
this file and the canonical win. The feature re-architects every JSON/HTTP endpoint on the
authoritative game server (`server/`) behind one in-house request pipeline. Goal:
maintainability, security, testability, observability. NOT a concurrency-scalability fix
(the single-threaded 20 Hz world loop is the per-realm ceiling, a separate out-of-scope
workstream), NOT a gameplay change, NOT a WS wire change.

## Current phase

Phase 06 (typed schema validator) DONE + QA DONE (2026-06-30: one PURE server-only module, NOT wired into the live server until Phase 8/9; no DB, no middleware, no route change). New `server/http/schema.ts` (150 code lines, zero new deps): the combinators `object/str/num/bool/enum_/optional(schema, default?)` produce a `Schema<T> extends StandardSchemaV1<unknown,T>` exposing `decode(input, pointer?) -> { ok:true; value } | { ok:false; issues }`; `Issue` is `{ pointer, code, params? }` with STABLE codes (`type|required|min|max|int|minLength|maxLength|enum`), never English; `Infer<typeof S>` derives the handler input type with no parallel interface. decode() collects ALL field issues in ONE pass. `object()` reads ONLY declared keys (via `Object.hasOwn`) into a null-proto (`Object.create(null)`) output, so an input `__proto__`/`constructor` key cannot pollute a prototype; `num()`/`bool()` coerce strings (params/query arrive as strings). TWO reconciliations vs the (stale) phase-06 doc text, both matching THIS file's canonical plan: (a) NO new `server/http/standard_schema.ts` - the Standard Schema v1 type is already vendored in the Phase-2-frozen `types.ts` (the single home, "Phases 4 to 9 import, never redefine"), so schema.ts imports `StandardSchemaV1`/`StandardSchemaProps`/`StandardSchemaResult`/`StandardSchemaIssue` from `./types`; (b) NO `server/http/index.ts` barrel (it is the Phase 09 deliverable; spine uses direct extensionless imports). The `~standard` conformance is type-only; the runtime `~standard.validate` is a thin sync decode() adapter that still emits codes (`message = issue.code`). Reviewers verdict 0 BLOCKING (privacy-security-review 0/0, qa-checklist 0/0, adversarial-correctness 0 BLOCKING / 3 SHOULD-FIX): the 3 SHOULD-FIX applied as a deliberate input-boundary HARDENING (decided in QA, noted for Phase 10+ callers): `num()` string coercion is now CANONICAL DECIMAL only (a `DECIMAL` anchored/ReDoS-safe regex; `'0x10'`/`'1e3'`/grouped strings rejected with code `type`); `num({int})` requires `Number.isSafeInteger` (no >2^53 id aliasing); `optional(schema, default)` CLONES a mutable (object/array) default per decode (`structuredClone`) so it is never shared by reference. Plus NITs: null-proto object output, `bool()` trims for parity with `num()`, and added coverage. Schema tests (runtime + tsc-checked type-level Infer/`~standard` assertions, incl. a nested + `optional(object())` exactness check); tsc/biome(ci:changed)/build:server all green; ASCII-clean. Deferred: code->HTTP-status + problem+json (P7), the withBody/validate middleware (P8), RouteDef.schema wiring + registry + the index.ts barrel (P9), concrete page/pageSize bounds + envelope (P10), client i18n matcher (P22). Phase 06 QA gate (phase-06-qa.md, dedicated adversarial pass): PASS, 0 BLOCKING; 4-auditor fan-out + per-finding verify CONFIRMED 1 SHOULD-FIX + 3 NIT, all TEST-COVERAGE (no schema.ts change; the module re-verified defect-free), and REFUTED 3 (a redundant params-survival assertion + two subjective dead-code simplifications). The 4 test additions pin: the object() makeDefault() clone path (a SECOND clone site separate from optional().decode(undefined), so a mutable default in an object field is non-aliased per decode), the null-prototype output construction, `~standard.validate`'s multi-segment pointer->path conversion, and a SHAPE-declared `__proto__` key being pollution-safe. After hardening: 37 schema tests; `tests/server/http/` 233 pass; tsc/biome(ci:changed)/build:server all green; ASCII-clean. Next: Phase 07 (RFC 9457 error model + error_codes catalog, phase-07-error-model.md).

Phase 05 (onion compose + request context) DONE + QA DONE (2026-06-30: two server-only spine primitives, NOT wired into the live server until Phase 9; no `server/http/index.ts` barrel). `server/http/compose.ts` (`compose` = the canonical Koa onion dispatch with a `lastIndex`-cursor double-next guard rejecting `'next() called multiple times'`; `runOnion` = the OUTERMOST wrapper that runs the composed stack inside `runWithReqId(ctx.reqId, ...)` then guarantees EXACTLY ONE response via a total `finalizeResponse` helper; `respondOnce` = the headersSent/writableEnded-guarded idempotent sender) + `server/http/context.ts` (`buildContext` producing the frozen `Ctx` and reading the match ONLY for params since `Ctx` has no `route` field; reuses `ratelimit.requestIp` for `ctx.ip`; `query`/non-matched `params` are `Object.create(null)`; plus the reqId carrier `reqIdStorage`/`newReqId` (crypto.randomUUID)/`runWithReqId`/`currentReqId`). compose imports `Ctx/Middleware/Next` from `./types` and `runWithReqId` from `./context` (no redefine, no import cycle). Reviewers verdict PASS, 0 BLOCKING (privacy-security-review + qa-checklist + fresh coverage subagent): qa + coverage PASS with every acceptance criterion met by a regression-sensitive test; privacy 2 SHOULD-FIX (forward-looking) + nits, ALL applied: `buildUrl` now pins `ctx.url`'s authority to the placeholder by ASSIGNING path+search onto a fixed-origin URL, so neither absolute-form (`GET http://evil.com/...`) NOR an origin-form target that normalizes to a leading `//` (`/..//evil.com`, the QA-pass BLOCKING fix) can inject a host into the frozen `ctx.url`, AND is total (catches a malformed-target `new URL` throw so `buildContext` never throws before runOnion's net); `finalizeResponse` makes runOnion's net total (swallows a dead-socket throw, `end()`s a headers-committed-but-unended response). Fallbacks emit NO body/stack/SQL/table/English; statuses are named consts (no-response 404, throw 500), both carry `X-Request-Id`. 43 http unit tests (37 + 6 from the QA pass); full `npm test` 613 files / 6463 pass / 11 skip; tsc/biome/ci:changed/build:env/build:server/build all green; ASCII-clean. The Phase 2 `fake_ctx.ts` was left UNTOUCHED (a test asserts buildContext and fakeCtx share the same own-key set). Phase 05 QA (phase-05-qa.md) verdict: PASS-WITH-FOLLOWUPS-RESOLVED (4 adversarially-verified auditors): 1 BLOCKING (the in-phase host-injection fix was INCOMPLETE for `//`-pathname targets; closed by the fixed-origin-URL rebuild), 2 SHOULD-FIX + 2 NIT coverage gaps, all applied. Next: Phase 06 (typed schema validator, phase-06-schema-validator.md).

Phase 04 (table router) DONE + QA DONE (2026-06-30: two PURE, server-only modules, NOT wired into the live server until Phase 9). `server/http/path_pattern.ts` (compilePattern = the no-regex routing guard, normalizePath, matchPattern, and the HttpMethod/PatternSegment/CompiledPattern types) + `server/http/router.ts` (createRouter over a Map<HttpMethod,{static:Map,dynamic[]}>, returning the MatchResult union). Phase 04 QA verdict PASS, 0 BLOCKING (1 context Explore + 4 parallel reviewers: correctness 0 findings / all 21 acceptance criteria verified, dead-code 0, privacy-security PASS, test-coverage 1 SHOULD-FIX + 3 NIT coverage gaps, no code defects). All applied: added a 405-via-dynamic-route test (the canonical wrong-method-on-a-resource case, asserted nowhere before), multi-param capture, PUT/PATCH METHOD_ORDER positions, and a structural server-only purity test (criterion 16, no `../`/`node:` imports); hardened `matchPattern` to build params with `Object.create(null)` (defense-in-depth on top of the reserved-name guard). 60 unit tests; full npm test 611 files / 6420 pass / 11 skip; tsc/biome/build:env/build:server/build all green; ASCII-clean. See "Phase 4 router contract" below for what Phases 5/7/9/17 inherit. Next: Phase 05 (onion compose + request context, phase-05-onion-context.md).

Phase 03 (surface inventory + content-type classification + characterization/golden corpus + knownDeviations) DONE + QA DONE (2026-06-30: tests/docs only, ZERO runtime behavior change; 106-row HEAD-anchored inventory + route-count freshness gate, 5-class /api content-type classification, golden corpus over the four dispatchers replayed through routeHttpRequest + the Phase 2 goldenMaster/normalizer, 12 seeded knownDeviations). Phase 03 QA verdict PASS-WITH-FOLLOWUPS (1 BLOCKING + 3 SHOULD-FIX + nits all fixed; no golden blessed a security defect): account/email/verify + email/unsubscribe were misclassified HTML but emit application/json, RECLASSIFIED to PROBLEM_JSON (HTML now maps to /api/auth/discord/callback ONLY); added content_type_consistency.ts cross-check (every golden's content-type vs its route class, wired through both characterization files); de-binarized surface_inventory.test.ts (raw NUL key delimiters escaped) + a method-aware freshness subset guard; new goldens for email/verify 400 + the wrong-method 404 baselines (wired into planned405BeforeAuth) + the per-route /internal/discord secret-unset 404. Corpus 57->67 fixtures, suite 73->84 tests byte-stable; tsc/biome/ci:changed/build:server green; full tests/server 196/196. Next: Phase 04 (table router, phase-04-router.md). KEY CORRECTIONS this phase surfaced (see below): the Discord callback is HTML (200 text/html bounce), NOT a 302 redirect; REDIRECT maps to zero routes today; the only /api HTML route is the Discord callback. Phase 02 + QA DONE (frozen contracts + self-tested harness + clock seam; all 11 criteria PASS). Phase 01 + QA DONE.

## Phase 2 frozen contracts (Phases 4 to 9 IMPORT these, never redefine)

The single home is `server/http/types.ts` (TYPE-ONLY, zero runtime emit). Verbatim:
- `RouteDef`: `{ method: Method; path; surface: Surface; middleware?; schema?; params?; query?; handler: RouteHandler; meta? }`. Handler is req/res-free `(ctx: Ctx) => Awaitable<unknown>`.
- `RouteMeta`: `{ requireOwned?: { kind; ownerScope: 'account'|'operator' }; publicRead?: boolean; envelope?: EnvelopeKind; deprecated?; sunset? }`. The BOLA coverage helper EXCLUDES operator-scoped and `publicRead` :id routes; `publicRead` is the Phase 10 marker for genuinely public `:id` reads.
- `EnvelopeKind` (7): `'problem+json' | 'oauth' | 'admin' | 'html' | 'redirect' | 'binary' | 'legacy405'`. `Surface` (4): `'api' | 'oauth' | 'admin' | 'internal'`. `Method`: GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD.
- `Ctx`: `{ req; res; method; url: URL; path; query; params; ip; reqId; body?; account?: { accountId; scope: 'read'|'full' }; state: Map<string,unknown> }`. Phase 5 buildContext produces it; fakeCtx mirrors it.
- `Middleware = (ctx, next) => Promise<void>`, `Next = () => Promise<void>`. Schema slot = Standard-Schema-v1 (`StandardSchemaV1`); Phase 6's validator implements it.
- `RateLimitStore`: `{ hit(key, maxPerMinute): Awaitable<RateLimitOutcome>; reset(): Awaitable<void> }`, `RateLimitOutcome = { allowed; remaining; resetSeconds }`. TYPE-ONLY now; FakeRateLimitStore implements it on an injected clock; Phase 19's PgRateLimitStore implements the SAME interface. The existing ratelimit.ts functions still return booleans (return-shape rework is Phase 19).
- Dispatch flag: env `API_DISPATCH` = `'legacy' | 'new'`, default `'legacy'` (Phase 25 flips the default; Phase 24 wires loadConfig into boot). loadConfig(env) is pure and frozen; required value = DATABASE_URL (value-free fail-fast).
- Normalizer placeholder set (load-bearing for Phase 3): exported `NORMALIZER_PLACEHOLDERS` = id/timestamp/token/requestId/date/expires/nonce. Field-name-driven; the generic key `state` is deliberately NOT masked (oauth `state` is masked later with surface context). The parity driver's per-pass isolation resets EVERY limiter bucket (incl. the failed-login bucket) + the clock + an injected hook.

## Phase 4 router contract (Phases 5/7/9/17 consume this; the router is built in Phase 4 but wired in Phase 9)

`server/http/router.ts` `createRouter(routes)` returns `{ match(method, path): MatchResult }`. `MatchResult` is a discriminated union: `{ kind:'matched'; route; params; head }` | `{ kind:'methodNotAllowed'; allow }` | `{ kind:'options'; allow }` | `{ kind:'notFound' }`. `HttpMethod` is an ALIAS of the canonical `Method` (server/http/types.ts); `RoutePattern = { method, path }` is structurally satisfied by `RouteDef`, so Phase 9 calls `createRouter<RouteDef>(...)`.
- The router is a PURE match function: it returns DESCRIPTORS, never writes a header/response and never chooses an error envelope. The 405/404/OPTIONS WRITES are Phase 9's; the localized error BODIES are Phase 7's.
- HEAD maps to GET for lookup and sets `head:true` on the matched result (the dispatcher serves a GET handler but suppresses the body). OPTIONS is SYNTHESIZED from the real method set: `{ kind:'options', allow }` on a known path, `notFound` on an unknown one. Phase 9 must serve the synthesized OPTIONS as 204 with `Allow:` + `Vary: Origin` (the router writes neither header). The Allow set always includes synthesized OPTIONS and (when GET is registered) HEAD, ordered by a complete METHOD_ORDER map.
- Honest 405 + Allow is the DEFAULT. The anti-enumeration 404-instead-of-405 override on auth routes is Phase 9's (applied from an explicit list intercepting the `methodNotAllowed` kind); do NOT special-case it in the router.
- normalizePath strips exactly ONE trailing slash (root `/` preserved); it does NOT collapse internal slashes, decode percent-encoding, or resolve `..`. So the router receives a CLEAN pathname: Phase 5 URL parsing owns percent-decode + `..` resolution and MUST NOT decode `%2F` into a path separator before handing the path to the router. SEAM OBLIGATION (Phase 9): the auth gate must authorize on the SAME normalized path the router matches (an exact-string gate on an un-normalized path while the router matches the normalized path is a trailing-slash bypass).
- The no-regex routing guard (compilePattern) accepts only literal segments + plain `:name` (char-by-char, no regex anywhere, ReDoS-safe by construction). It REJECTS the admin enum-alternation route `/admin/api/moderation/accounts/:id/(suspend|unsuspend|ban|unban)`, which is why Phase 17 must restructure that to `:param` + schema. It also rejects reserved param names (`__proto__`/`constructor`/`prototype`) at compile time. The captured-params object `matchPattern` returns is built with `Object.create(null)` (no inherited `Object.prototype` keys), so a downstream lookup by an untrusted key can never read an inherited member: belt-and-suspenders on top of the reserved-name guard (param VALUES from the wire are only ever stored under validated NAMES, never used as keys).
- BUILD-TIME guards in createRouter: registering HEAD or OPTIONS throws (they are synthesized, so a HEAD-only route is intentionally inexpressible; the Phase 3 inventory has none). Duplicate detection is by SHAPE (params replaced with a `:` placeholder), so textual dups, trailing-slash dups, AND param-name-equivalent dups (`/a/:x` vs `/a/:y`) all throw. CROSS-shape dynamic overlaps (e.g. `/:resource/special` vs `/characters/:id` both matching `/characters/special`) are ALLOWED and resolve to the FIRST registered: Phase 9's registry must order more-specific dynamic routes first (no specificity tiebreak in the router by design). SEAM OBLIGATION (Phase 9, BOLA): because the router has no specificity tiebreak, a catch-all leading-`:param` route registered BEFORE a specific route can shadow a route carrying a `requireOwned` loader; the Phase 9 registry must order specific dynamic routes ahead of catch-alls AND add an introspection check that no overlapping dynamic shape leaves a `requireOwned` route shadowed by a non-owned one (Phase 04 QA, privacy-security).
- match() expects an UPPERCASE method token (HTTP methods are case-sensitive per RFC 9110; Node delivers uppercase). An unrecognized method (junk, or lowercase) on a known path returns `methodNotAllowed` (405), not a distinct 501: the MatchResult has no 501 variant, so if Phase 7/9 ever wants 501-Not-Implemented vs 405, that is an error-model mapping (and a contract extension), not router behavior.

## Locked design decisions

### The five 2026-06-30 user decisions
1. **Delivery = stacked PR chain.** Each phase is its own green, bisectable PR; the suite
   stays green at every commit. Pairs with the ~40%-context-per-phase bound: small phases,
   small PRs, small reviews.
2. **Coexistence = a single all-or-nothing env dispatch flag.** The flag controls whether
   the new pipeline sits in front of the old `handleApi`. New path is the DEFAULT (and the
   path the suite targets). The new dispatcher delegates un-migrated paths to the old ladder
   via a per-path catch-all so partially-migrated states work. Rollback = flip the one flag
   (all migrated routes revert to the old ladder at once). ACCEPTED TRADEOFF (chosen
   knowingly): a flag flip reverts the hardening too (new limiters, BOLA loaders, bearer-gap
   close, security headers, em-dash fix all live on the new path). The old ladder is deleted
   in the NEXT release once the metric exit-criteria are clean (Phase 25 names them).
3. **CORS + the OPTIONS-204 short-circuit + the security-headers wrapper stay TOP-LEVEL
   `createServer` wrappers** covering BOTH old and new paths, so a routing rollback cannot
   drop CORS/preflight or security headers. They are NOT inside the per-route onion only.
4. **Discord family in scope this packet.** The SPEC predates the Discord/guild/moderation
   merge; the Discord identity endpoints, schema wiring, orphaned handler, and limiter are
   migrated here (see Discord family below).
5. **BOLA denial status:** 404 for player-owned objects (anti-enumeration); 403 for
   admin/operator-scoped routes.

### Scope and goal
- IN SCOPE: every JSON/HTTP endpoint across the four sub-dispatchers (main `handleApi`,
  admin, oauth, internal) on `server/`.
- No heavy web framework. Zero new runtime dependencies; the ONE weighed exception is
  `prom-client`, and ONLY when the `/metrics` exporter lands (Phase 23).
- All `file:line` anchors in the source SPEC (`docs/api-pipeline/source-spec.md`) are STALE
  (main.ts ~1695 lines). Re-anchor on SYMBOL NAMES and route strings, never line numbers.

### Target architecture
- Domain-agnostic spine under `server/http/`: `router.ts`, `compose.ts`, `context.ts`,
  `schema.ts`, `errors.ts`, `error_codes.ts`, `registry.ts`, `index.ts` (barrel),
  `middleware/*.ts`, plus a pure `config.ts` (`loadConfig`).
- Component-first layout: each `server/<domain>.ts` exports `export const routes:
  RouteDef[]`. Handlers are THIN; domain functions take no req/res so the same core serves
  REST and WS and is unit-testable.
- `RouteDef` carries method, path, middleware, schema, params, query, handler, and metadata
  (`requireOwned*` presence, per-surface envelope, deprecated/sunset).
- Router: in-house `Map<method,{static:Map<path,Route>, dynamic:Route[]}>`. Static match
  O(1); dynamic captures `:param` with NO per-request regex. Known-path wrong-method -> 405
  + Allow header BEFORE auth/handler. Deliberate anti-enumeration 404 on auth routes kept
  via an explicit `knownDeviation` list. HEAD-for-GET, synthesized OPTIONS, single
  trailing-slash normalization (convention H), `Vary: Origin`. A no-regex-routing guard
  asserts every pattern is literal segments or a plain `:param`.
- Onion: Koa-compose recursive dispatch (~15 lines) with a double-next guard, ordered
  cheap-reject-first (IP-keyed limits before body+DB; account-keyed limits after auth).
  `compose()` returns a promise and does NOT send a response or catch on its own (see
  gotchas). Validator: tiny in-house (~150-line cap), NO zod/valibot, collects ALL field
  issues in ONE pass, implements the Standard Schema v1 `~standard` type shape, handler
  input DERIVED via `Infer<typeof S>`, typed params AND query.

### Error + status model (RFC 9457 / 9110 / 6585 confirmed)
- Per-surface envelopes chosen by a single `mapError`, NEVER one global serializer:
  - `/api` JSON: RFC 9457 `application/problem+json` (type/title/status/detail/instance +
    a stable machine `code`; clients localize by CODE, not by parsing `detail`).
  - `/oauth` POST JSON: RFC 6749 `{error, error_description}`.
  - `/admin`: `{success, data, error}`.
  - HTML routes (OAuth GET consent/device pages): `htmlError` HTML page. (NOTE: the `/api/account/email/verify` + `/api/email/unsubscribe` link-click endpoints LOOK like pages but answer application/json in every branch, so they are PROBLEM_JSON, not HTML; Phase 3 QA corrected an initial misclassification.)
  - Discord callback: text/html bounce page (200, client-side `location.replace`), NOT a 302
    redirect and NOT problem+json. Phase 3 characterization CORRECTED the SPEC's "302" assumption
    (the handler `bouncePage` writes `Content-Type: text/html`); it needs the HTML-error serializer,
    not a redirect serializer. The REDIRECT envelope/class maps to ZERO routes today.
  - Binary route (card upload): binary/no-JSON-wrap.
  - The legacy `{ok:false}` 405 (perf_report + site_presence non-POST) is a 4th characterized
    contract case (perf_report's own 405 is unreachable via handleApi's POST-gated arm; site_presence
    is method-agnostic so its non-POST 405 is the live one).
- Status codes: 422 well-formed-but-invalid (one-pass collected), 400 malformed JSON, 413
  over byte cap (Content Too Large), 409 unique-violation, 401 missing/invalid token (+
  `WWW-Authenticate`), 403 no-entitlement, 429 + `Retry-After`. Unknown -> logged 500 with
  NO stack/SQL/table text in the body.
- `error_codes.ts` is the single `as const` source of truth, frozen `(domain, reason)` +
  param keys, APPEND-ONLY (AIP-193). Reuse the existing `domain.reason` vocabulary.

### Non-JSON `/api` classification (a blanket rule WOULD break prod)
The `/api` surface is NOT uniformly JSON. A global `415 application/json` + JSON-only
`withBody` + blanket problem+json WOULD break: `POST /api/card` (binary `image/png` via
`readBinaryBody`) and `GET /api/auth/discord/callback` (text/html bounce, NOT a 302; Phase 3
corrected this; it is the ONLY /api route that emits text/html). (`GET /api/email/unsubscribe`
and `GET /api/account/email/verify` answer application/json, so they do NOT break the blanket;
Phase 3 QA corrected an initial HTML misclassification of both.) Therefore: classify every `/api` route by
response content-type; ship a
`withRawBody`/binary middleware variant; exempt declared non-JSON routes from 415 + JSON
withBody; roll out 415 in LOG-ONLY mode first until native (Capacitor) traffic is confirmed.
Audit each beacon endpoint (`/api/site-presence`, `/api/perf-report`) actual Content-Type.

### Rate limiting (two-tier)
Tier-1 in-memory IP gate runs FIRST (floods never reach pg); tier-2 global-keyed atomic
UPSERT in a NEW `server/ratelimit_db.ts` modeled on `bug_report_db.ts` (pg-tier for
multi-realm). Limiters change from boolean to `{remaining, resetSeconds}` (~5 files; Phase
19), using the injected `now()` clock (Phase 2) for deterministic tests. `RATELIMIT_SCHEMA`
MUST be explicitly added to the `ensureSchema` statement list under the boot advisory lock,
with a boot-time table-existence assertion (the exact trap the UNWIRED `DISCORD_SCHEMA`
fell into). Emit draft-11 / RFC 9651 `RateLimit` + `RateLimit-Policy` structured-field
headers (q/w/r/t, pinned to a draft version in a comment) + `Retry-After`, NOT the legacy
trio. Handler-level checks KEPT (cannot be pre-handler middleware): `authThrottled`
(per-username, failed-only, clears on success, 15m/10-fail); `rateLimitedPerfReport`
returns 200 BY DESIGN. NEW limiters (labeled-behavioral knownDeviations):
character.create/rename/delete/takeover, reports.create; the Discord limiter
(DISCORD_MAX_PER_MINUTE=15, ip+account) is the genuinely-new 8th surface.

### Discord family (Phase 16)
- Migrate `POST /api/auth/discord/start`, `GET /api/auth/discord/callback` (text/html bounce,
  NOT a 302, classified non-JSON), `GET /api/discord` (status), `DELETE /api/discord` (unlink) onto
  RouteDefs.
- WIRE the unwired `DISCORD_SCHEMA` (5 tables in `discord_db.ts`) into `ensureSchema` here.
- FIX the orphaned `handleSwagClaim` (implemented + tested in `discord.ts` but never
  dispatched in main.ts, currently unreachable over HTTP).
- Add a `discord.*` ip+account policy to POLICIES and Discord error codes to the catalog +
  client matcher. Carry forward the `isIpBlocked` + turnstile parity gap from prior reviews.
- The 8 secret-gated `/internal/discord/*` bot-channel endpoints migrate in Phase 18,
  preserving their `x-woc-discord-secret` gate.

### BOLA / object-level authorization
Load-then-authorize `requireOwned*` resource-loader: scope-before-find, account-scoped
query, populates `ctx.<resource>`. Deny-by-default coverage test over the route registry:
every ACCOUNT-OWNED `:id` route resolves through an account-scoped loader. Admin
operator-scoped `:id` routes are EXCLUDED from the owner clause and use an admin-scope
loader. Structured `bola_denied` deny logging. Denial status: 404 player-owned, 403
admin/operator (see decision 5).

### Security headers (Phase 21)
`withSecurityHeaders` via a TOP-LEVEL wrapper on the createServer prefix ladder so it
covers serveStatic, `/c/` SSR, `/p/` card, `/avatar`, sitemap, OAuth GET pages AND the
route onion: nosniff, Referrer-Policy, Permissions-Policy deny-all, HSTS in prod, COOP/CORP
same-origin, frame-ancestors/X-Frame-Options on OAuth, Cache-Control no-store on
auth/token, strip Server + X-Powered-By. Explicitly NO COEP:require-corp (would break
cross-origin GLB/HDRI). Full CSP is a SEPARATE Report-Only effort, NOT enforced here.

### World Market realm-scope fix (Phase 20, own PR, migration-safety reviewer)
Highest-consequence change (normal-operation item loss). Realm-scope the `world_state`
`'market'` key at BOTH write sites in lockstep (anchor on `saveCharacterAndMarketState`
escrow txn AND `saveWorldState`) PLUS the read (`loadMarketState`). Add a backfill that
PARTITIONS the existing global blob by each seller character's realm, idempotent under the
advisory lock, with a boot-ordering gate before the first new-key write, a dry-run +
escrow-sum/row-count verification, and a documented data-rollback. JSONB
`serializeCharacter` with a defensive `??` default keeps new state fields back-compatible.

### REST i18n matcher (Phase 22)
The live `/api` REST error matcher is `userFacingApiError` in the game CLIENT
(`src/main.ts`), a startsWith/exact/regex matcher, NOT `server_i18n` (WS-only), currently
UNGUARDED (the S3 guard scans only the WS path). Extend it to look up emitted CODES
directly in the client catalog instead of reverse-matching English prose; port parametric
cases (suspended-until {date}, {seconds} rate-limit families) to `{code, params}`; add
`apiError.*` English catalog entries; add a per-surface code-parity Vitest asserting every
server-emitted code resolves in EVERY locale (append-only frozen), covering the ~30-45
EXISTING REST strings too. Numbers/dates/durations format client-side via
`formatNumber`/`formatDuration`/`Intl`. Em-dash fix: the U+2014 rate-limit strings get the
dash swapped to a comma in the SAME change as the matching `userFacingApiError` change
(prefix unchanged so startsWith still resolves); also fix the operator-facing em dashes in
`src/admin/i18n.locales/en_CA.ts`.

### No-magic-values + config (Phase 24)
Every tunable (rate limits + windows, byte caps, page sizes, timeouts, TTLs, pool sizes,
maxPayload, drain window) is a NAMED constant, single source of truth, env read ONCE via a
pure validated `loadConfig(env)` (separate from the boot call site). POLICIES values DERIVE
from existing named constants, never re-typed literals. Server timeouts
(requestTimeout/headersTimeout/keepAliveTimeout/maxHeaderSize) set in `startServer()` with
named constants, mindful of the WS upgrade handshake and the 1 MB card upload.

### API conventions
- SHIP NOW: B (pagination `{items, page, pageCount, total, pageSize}`), H (trailing-slash),
  I (drain-aware health: `/livez` + `/readyz`, `/readyz` NOT-ready during SIGTERM drain).
- DEFERRED to a consumer-driven follow-up: A (versioning), D (ETag), F
  (Deprecation/Sunset), G (OpenAPI). Ship paths UNVERSIONED.

### Performance gate
Non-goal: NO realtime regression. Pipeline (compose recursion + ALS + per-route metric
write + full-issue schema validation) runs on the SAME event loop as the 20 Hz world loop.
Acceptance gate: the pipeline adds < X ms p99 per request and does NOT raise tick p95 above
0.8 x DT, measured against the existing perf harness. (Phase 24 codifies the gate and picks
the X-ms constant; X is TBD, see open items.)

## Non-negotiable constraints (every phase keeps all of these)
- **Determinism / sim purity:** sim randomness via `Rng` only; NEVER
  `Math.random`/`Date.now`/`performance.now` in `src/sim/`. This work is SERVER-ONLY and
  should not touch `src/sim/` (server time is fine; Phase 2 injects a `now()` clock so
  limiter tests are deterministic). `src/sim/` imports nothing from render/ui/game/net; no
  DOM/Three (guarded by `tests/architecture.test.ts`). The only client-side touch is the
  i18n matcher in `src/main.ts` + the `apiError.*` catalog (Phase 22).
- **Server authority:** clients stream intent; the server resolves all outcomes. This
  packet does not change that and does not change the WS wire/snapshots. If a phase would
  change them, STOP and surface it.
- **Stable-code i18n:** every player-visible string is a `t()` key in every locale; the
  server stays language-agnostic and emits a stable CODE re-localized at the client
  boundary. The S3 guard is `tests/localization_fixes.test.ts`.
- **Additive idempotent DDL:** boot-time DDL under the advisory lock (`CREATE TABLE IF NOT
  EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`); there is NO migrations directory;
  the inline DDL IS the schema. JSONB back-compat for existing character state; round-trip
  test. New schemas MUST be added to the `ensureSchema` statement list (the DISCORD_SCHEMA
  trap).
- **No magic values:** every tunable is a named constant via `loadConfig(env)` (Phase 24).
- **No generated-file edits:** do not hand-edit generated files (regenerate via the build).
- **Shared-worktree commit care:** concurrent sessions exist. Commit with EXPLICIT paths,
  never `git add -A`. Conventional Commits with a scope (`feat(http): ...`,
  `fix(server): ...`, `test(server): ...`).
- **No em dashes, en dashes, or emojis** anywhere (code, comments, docs, commits, copy).
  Enforced by the Stop hook + pre-push copy scan.
- **Module-first:** spine under `server/http/` + per-domain route modules; NEVER grow
  main.ts. Biome on CHANGED files only (`npm run ci:changed`); scoped `npx @biomejs/biome
  check --write <file>` only; NEVER a whole-tree `--write`.

## Validation matrix (by change type)
- **Any code change (baseline):** `npx tsc --noEmit` + `npx vitest run
  tests/server/<domain>.test.ts` (and any existing affected suite) + `npm run ci:changed`
  (Biome on changed files).
- **Spine / primitive phases:** `npx vitest run` the new `tests/server/http/*.test.ts`.
- **Server build:** `npm run build:server`.
- **Player text / codes added or changed:** `npx vitest run
  tests/localization_fixes.test.ts` (S3) + the new per-surface code-parity test.
- **Persistence / DDL changed:** idempotent-DDL re-run test + JSONB save/load round-trip
  test; dispatch the `migration-safety` reviewer.
- **Each phase is a PR; pre-merge gate (mirror CI):** `npm test && npx tsc --noEmit && npm
  run build:env && npm run build:server && npm run build`.
- **WS wire/snapshots are NOT expected to change.** If a phase would change them, STOP and
  surface it.
- **Review dispatch (spawn ONLY matching surfaces; check `git diff --name-only`):**
  `privacy-security-review` (`server/` touched, esp. auth/BOLA/rate-limit/headers/secrets/
  SQL), `migration-safety` (`db.ts`, `ratelimit_db.ts`, `discord_db.ts` wiring, the market
  fix, any DDL/JSONB shape change), `cross-platform-sync` (ONLY if IWorld/`src/sim`/wire/the
  matchers/RL surface change, mostly only Phase 22), `architecture-reviewer` (ONLY if
  `src/sim/` changes, which this packet should NOT), `qa-checklist` (each phase completion).

## Key file paths
- **Existing server sub-dispatchers (the four):** main `handleApi` in `server/main.ts`;
  admin `handleAdminApi` in `server/admin.ts`; `server/oauth.ts`; `server/internal.ts`.
- **Existing domain handlers / db modules to draw from:** `server/account.ts`,
  `server/wallet.ts`, `server/discord.ts`, `server/discord_db.ts`, `server/discord_oauth.ts`,
  `server/auth.ts`, `server/native_attestation.ts`, `server/character_sheet.ts`,
  `server/perf_report.ts`, `server/site_presence.ts`, `server/bug_report_db.ts`,
  `server/ratelimit.ts`, `server/ip_block.ts`/`ip_block_db.ts`, `server/turnstile.ts`,
  `server/moderation_db.ts`/`moderation_service.ts`, `server/social_db.ts`, `server/db.ts`,
  `server/http_util.ts`, `server/web_login_guard.ts`.
- **Spine modules to be CREATED (`server/http/`):** `router.ts`, `compose.ts`, `context.ts`,
  `schema.ts`, `errors.ts`, `error_codes.ts`, `registry.ts`, `index.ts` (barrel),
  `config.ts` (pure `loadConfig`), `middleware/*.ts`, plus the importable `ws_auth` module
  (Phase 1).
- **New persistence:** `server/ratelimit_db.ts` (RATELIMIT_SCHEMA wired into `ensureSchema`).
- **New per-domain route modules:** `server/leaderboard.ts`, `server/characters.ts`,
  `server/reports.ts` (each `export const routes: RouteDef[]`); existing files get a `routes`
  export added (`account.ts`, `wallet.ts`, `discord.ts`, `admin.ts`, `oauth.ts`,
  `internal.ts`).
- **Tests:** `tests/server/<domain>.test.ts`, `tests/server/http/<primitive>.test.ts` (the
  `tests/server/` directory is created in Phase 2).
- **Client i18n (Phase 22):** `apiError.*` catalog domain (a `src/ui/i18n.catalog/` module);
  `userFacingApiError` in `src/main.ts` extended; `src/admin/i18n.locales/en_CA.ts` em-dash
  fix.

## New files created per phase
| Phase | New files |
|---|---|
| 01 | DONE. importable `server/ws_auth.ts` (`createWsAuth(deps)` factory -> `{ authenticateWebSocket, onConnection, attachUpgrade(server, wss) }`, wire vocabulary in named constants); in `server/main.ts`: exported `startServer(): Promise<http.Server>` + exported pure `routeHttpRequest(req, res)` dispatcher + `require.main === module` entry guard (NOT import.meta: esbuild empties it under cjs); `tests/server/` dir with `ws_auth.test.ts` + `importable_spine.test.ts` + `route_dispatch.test.ts` (the last added in Phase 01 QA: pins routeHttpRequest's OPTIONS-204 short-circuit + prefix dispatch by mocking the imported sub-dispatchers). NO `server/http/` dir this phase (that is Phase 4+). |
| 02 | DONE. `server/http/types.ts` (TYPE-ONLY frozen contracts; see "Phase 2 frozen contracts" above) + `server/http/config.ts` (pure `loadConfig`); `now()` clock injected into `ratelimit.ts` ONLY (ratelimit_db.ts does not exist until Phase 19), with `setRateLimitClock`/`resetRateLimitClock`/exported `WINDOW_MS`; `tests/server/{helpers,http}/` dirs + `tests/server/helpers/index.ts` barrel: `fake_http.ts` (FakeRes+makeReq) + `fake_ctx.ts` (fakeCtx+nextGuard) + `fake_db.ts` (CharactersDb/LeaderboardDb/ReportsDb + fakes + tsc drift guard) + `fake_ratelimit_store.ts` (FakeRateLimitStore) + `normalizer.ts` (NORMALIZER_PLACEHOLDERS) + `golden.ts` + `parity.ts` (runParity) + `registry_introspect.ts`; plus `tests/server/ratelimit_clock.test.ts` + `tests/server/http/config.test.ts`. Existing ad-hoc makeRes/makeReq suites NOT converted. |
| 03 | DONE. `tests/server/http/surface_inventory.ts` (106-row HEAD-anchored ledger, named DISPATCH/AUTH_SCOPE/REQUIRE_OWNED consts, `:param` rows carry the real RegExp in `match`, orphan flagged `unreachable:true`, leaderboard query-forks as `variant` rows) + `surface_inventory.test.ts` (route-count freshness gate: reads the 4 dispatcher SOURCE files, set-equality of exact `=== '<path>'` arms + `*Match` regex sources vs inventory, vacuous-pass guarded; + classification completeness); `content_type_classification.ts` (5 named classes PROBLEM_JSON/HTML/REDIRECT/BINARY/LEGACY_OKFALSE_405 + per-/api-path map; REDIRECT used by zero routes); `characterization.test.ts` + `characterization_admin_oauth_internal.test.ts` + `tests/server/fixtures/{main,admin,oauth,internal}/*.json` (57 byte-stable goldens via routeHttpRequest + Phase 2 goldenMaster/normalizer); `known_deviations.ts` + `known_deviations.test.ts` (12 seeded deviations). One biome.json line: golden-dir ignore `!tests/server/fixtures` (mirrors `!tests/parity/golden`). ZERO server/ or src/ change. |
| 04 | DONE. `server/http/path_pattern.ts` (pure compilePattern/no-regex guard + normalizePath + matchPattern + HttpMethod alias of Method/PatternSegment/CompiledPattern) + `server/http/router.ts` (createRouter over Map<HttpMethod,{static:Map,dynamic[]}>, MatchResult union, HEAD-as-GET, synthesized OPTIONS, honest 405+Allow, shape-based dup guard) + `tests/server/http/path_pattern.test.ts` + `tests/server/http/router.test.ts` (55 tests). PURE, not wired in until Phase 9. Did NOT touch index.ts/registry.ts (Phase 9). |
| 05 | DONE. `server/http/compose.ts` (`compose` Koa onion + `lastIndex` double-next guard, `runOnion` outermost one-response wrapper using a total `finalizeResponse`, `respondOnce` idempotent sender) + `server/http/context.ts` (`buildContext` -> frozen Ctx, match read only for params; `buildUrl` pins ctx.url authority + is throw-total; reuses `ratelimit.requestIp`; null-proto query/params; reqId carrier `reqIdStorage`/`newReqId`/`runWithReqId`/`currentReqId`) + `tests/server/http/compose.test.ts` (21) + `tests/server/http/context.test.ts` (22). `buildUrl` assigns path+search onto a fixed-origin URL (the QA pass closed a `//`-pathname authority-injection gap that the absolute-form-only test had masked). Imports frozen `Ctx/Middleware/Next` from types.ts (no redefine, no cycle). NOT wired in until Phase 9; no index.ts barrel. Phase 2 `fake_ctx.ts` UNTOUCHED. |
| 06 | DONE. `server/http/schema.ts` (PURE validator: `object/str/num/bool/enum_/optional` combinators -> `Schema<T> extends StandardSchemaV1<unknown,T>` with `decode()` + a thin codes-only `~standard.validate`; `Issue{pointer,code,params?}`, `DecodeResult<T>`, `Infer<S>`; stable codes type/required/min/max/int/minLength/maxLength/enum; all-issues-one-pass; `object()` reads declared keys via `Object.hasOwn` into a null-proto output; `num()`/`bool()` string coercion, `num()` decimal-only + `isSafeInteger`-int, `optional` clones object defaults) + `tests/server/http/schema.test.ts` (37). Imports the Standard Schema v1 type from the frozen `./types` (NO new `standard_schema.ts`); NO `index.ts` barrel (Phase 09). NOT wired in until Phase 8/9. QA gate (phase-06-qa.md) PASS: 0 BLOCKING, 1 SHOULD-FIX + 3 NIT all test-coverage, applied. |
| 07 | `server/http/errors.ts` + `server/http/error_codes.ts` + per-surface contract test. |
| 08 | `server/http/middleware/*.ts` (withErrors, requestId+ALS, withCors, withBody, withRawBody, requireAccount, thin rateLimit adapter, metric/access-log hook sink) + tests. |
| 09 | `server/http/registry.ts` + `server/http/index.ts` barrel; dispatcher-in-front wiring in `server/main.ts`; dual-path parity harness + registry-completeness path-set diff test. |
| 10 | `server/leaderboard.ts` + `tests/server/leaderboard.test.ts`. |
| 11 | auth `routes` (on `server/auth.ts`) + `tests/server/auth.test.ts`. |
| 12 | `server/characters.ts` + `requireOwnedCharacter` loader + `tests/server/characters.test.ts`. |
| 13 | account `routes` (on `server/account.ts`) + `tests/server/account.test.ts`; em-dash fix in `src/main.ts` + `src/admin/i18n.locales/en_CA.ts`. |
| 14 | wallet `routes` (on `server/wallet.ts`) + `tests/server/wallet.test.ts`. |
| 15 | `server/reports.ts` + `tests/server/reports.test.ts`. |
| 16 | discord `routes` (on `server/discord.ts`) + `tests/server/discord.test.ts`; DISCORD_SCHEMA wired into `ensureSchema` (`server/db.ts`); `handleSwagClaim` dispatched. |
| 17 | admin `routes` (on `server/admin.ts`) + `tests/server/admin.test.ts`; admin-scope loader. |
| 18 | oauth + internal `routes` (on `server/oauth.ts`/`server/internal.ts`) + tests. |
| 19 | `server/ratelimit_db.ts` (RATELIMIT_SCHEMA, wired into `ensureSchema`); limiter return-shape rework in `server/ratelimit.ts`; `respond429`; `tests/server/ratelimit_db.test.ts`. |
| 20 | market realm-key changes + partitioned backfill in `server/db.ts`; extend `save_character_and_market.test.ts`. |
| 21 | `server/http/middleware/security_headers.ts` + top-level wrapper in `server/main.ts`; 415 log-only + Origin/Sec-Fetch check + tests. |
| 22 | `apiError.*` client catalog module; `userFacingApiError` extension in `src/main.ts`; per-surface code-parity Vitest. |
| 23 | pino-shaped logger facade + access log; `/metrics` exporter (`prom-client`); `/livez` + `/readyz`; tests. |
| 24 | validated fail-fast config (extend `server/http/config.ts`); named constants module; timeouts in `startServer()`; perf/tick-jitter gate test. |
| 25 | docs (`server/CLAUDE.md`, root `CLAUDE.md`, new `server/http/CLAUDE.md`, i18n docs); `npm run new:endpoint` scaffold; flag-default flip. |

## New endpoints / route tables per phase
- **P10 (public reads):** `/api/leaderboard` (incl. `?board=guilds`, legacy `?limit=N`,
  `?scope`), `/api/arena/leaderboard`, `/api/releases`, `/api/project-stats`, `/api/search`,
  `/api/realms`, `/api/public/characters/:id/sheet`, dev-gated `/api/perf`; `/api/status`
  trimmed to `{ok,realm,players_online}`; bearer resolver closes the `/api/realms` +
  `/api/search` authz gap.
- **P11 (auth):** `/api/register`, `/api/login`, `/api/native-attestation/challenge`.
- **P12 (characters BOLA):** `/api/me/characters`, `/api/characters` (GET/POST),
  `/api/characters/:id` (DELETE), `/rename`, `/takeover`, `/standing`, `/sheet`.
- **P13 (account):** `/api/account/*` family (password/logout/email(+change/verify)/
  deactivate/export/marketing/2fa(setup/enable/disable)/companion-token); `email/verify` +
  `email-unsubscribe` classified PROBLEM_JSON (both answer application/json; Phase 3 QA
  corrected an initial HTML misclassification).
- **P14 (wallet):** `/api/wallet/link/challenge`, `/api/wallet/link` (POST/DELETE),
  `/api/wallet` (GET), `/api/woc/balance`, `/api/card` (withRawBody), `/api/referrals`.
- **P15 (reports/telemetry):** `/api/reports` (new reports.create limiter), `/api/bug-reports`,
  `/api/perf-report` (keep 200-not-429), `/api/site-presence`.
- **P16 (discord):** `POST /api/auth/discord/start`, `GET /api/auth/discord/callback` (HTML
  bounce, NOT a 302; the only /api HTML route), `GET /api/discord`, `DELETE /api/discord`,
  `POST /api/discord/swag/claim` (handleSwagClaim, newly dispatched).
- **P17 (admin):** the ~19 `handleAdminApi` branches as RouteDefs; enum-segment routes
  (suspend|unsuspend|ban|unban) become `:param` + schema-validated enum; `{success,data,error}`
  + page/limit pagination frozen.
- **P18 (oauth + internal):** `/oauth/token`, `/oauth/revoke`,
  `/oauth/device_authorization`, authorize-POST, device-POST (RFC 6749 JSON); GET
  authorize/device pages stay on the top-level ladder (HTML); `/internal/restart-countdown`
  + the 8 `/internal/discord/*` bot-channel endpoints (secret gate preserved).

## New DB tables / columns per phase
- **P16:** WIRE `DISCORD_SCHEMA` (5 tables: `discord_links`, `discord_oauth_states`,
  `reward_points`, `reward_ledger`, `swag_claims`) into the `ensureSchema` statement list
  under the advisory lock (currently UNWIRED on this branch; the canonical trap).
- **P19:** NEW `RATELIMIT_SCHEMA` table in `server/ratelimit_db.ts`, ADDED to the
  `ensureSchema` list under `pg_advisory_xact_lock`, with a boot-time table-existence
  assertion; global-keyed single-statement atomic UPSERT tier-2 backstop.
- **P20:** realm-scope the `world_state` `'market'` key (composite realm-key, not the bare
  global key) at both write sites + the read; partitioned idempotent backfill; no new table.
  JSONB `serializeCharacter` defensive `??` default keeps new state fields back-compatible.

## New error codes + i18n keys + the userFacingApiError matcher change (Phase 22)
- `error_codes.ts` (created P07) is the single `as const`, append-only (AIP-193) source;
  each migration phase appends `domain.reason` codes (reuse existing vocabulary). New codes
  include the Discord family (P16), the previously-unmatched wallet "rate limited" responses
  (P14), and the new character/reports limiter codes.
- **P22 matcher change:** extend `userFacingApiError` (`src/main.ts`) to look up emitted
  CODES directly in the client catalog instead of reverse-matching English prose; port the
  parametric cases (suspended-until `{date}`, the `{seconds}` rate-limit families) to
  `{code, params}`; preserve its dual REST + WS-disconnect-reason role.
- Add `apiError.*` English catalog entries; params formatted client-side via
  `formatNumber`/`formatDuration`/`Intl`. A per-surface code-parity Vitest asserts every
  server-emitted code resolves in EVERY locale (append-only frozen), covering the ~30-45
  EXISTING REST strings (currently unguarded; S3 scans only the WS path) + the new
  Discord/guild codes.
- Em-dash fix (paired with P13): swap the U+2014 rate-limit dashes to commas in the SAME
  change as the matcher (prefix unchanged so startsWith still resolves); also fix
  `src/admin/i18n.locales/en_CA.ts`.

## New named constants / config (Phase 24)
- A validated fail-fast config read ONCE at boot via the pure `loadConfig(env)` from P2
  (HSTS-in-prod, REQUIRE_WEB_LOGIN, realm/native-app origins, limiter DSN, the dispatch
  flag), replacing scattered `process.env` reads; log the active dispatch path at boot and
  alert if the old path is active in prod.
  - SECRET-LEAK GUARD (Phase 2 QA security note): `Config` returns secrets as plain readonly
    string fields (`databaseUrl`, `turnstileSecret`, `githubToken`). `loadConfig` itself never
    logs them, but the moment this is wired into boot, guard against a casual `console.log(config)`
    or error-serialization dumping the whole object: give `Config` a redacting `toJSON` (and/or a
    `util.inspect.custom`), or never hand the config object to a logger. Log only the dispatch
    path, never the config.
- Server timeouts in `startServer()`: `requestTimeout`, `headersTimeout`,
  `keepAliveTimeout`, `maxHeaderSize` as named constants (mindful of the WS upgrade
  handshake and the 1 MB card upload).
- Consolidate every tunable (rate limits + windows, byte caps, page sizes, timeouts, TTLs,
  pool sizes, maxPayload, drain window) into named constants with unit + comment; POLICIES
  values DERIVE from existing constants.
- Add the perf/tick-jitter acceptance gate (pipeline adds < X ms p99, tick p95 stays under
  0.8 x DT). X-ms constant is TBD (chosen here; see open items).

## Architecture decisions (locked, independently confirmed by code + 2024-2026 sources)
- **RFC 9457 `application/problem+json`** as the `/api` error format (obsoleted RFC 7807,
  no breaking member change), with a stable machine `code` as the load-bearing field;
  clients localize by code, MUST use type/code not parse `detail`.
- **Per-surface envelopes chosen by `mapError`, never one global flip** (problem+json /api,
  RFC 6749 /oauth, `{success,data,error}` /admin); all three shapes exist in code today.
- **The 422 / 400 / 413 / 429(+Retry-After) status model** (RFC 9110: 422 is now core HTTP;
  RFC 6585), a deliberate documented knownDeviation from today's 400-for-validation /
  500-for-malformed.
- **Hand-rolled ~150-line validator** conforming to the Standard Schema v1 `~standard` type
  shape with `Infer`-derived handler types (server ships nothing to a browser, so Valibot's
  bundle win is moot; the seam keeps a zero-churn swap open).
- **In-house static-Map table router** (literal segments + plain `:param`) over
  URLPattern/regex, 404-vs-405+Allow before auth, HEAD-for-GET, synthesized OPTIONS,
  trailing-slash normalization, no-regex-routing guard (ReDoS-safe by construction).
- **Koa-compose recursive-dispatch onion** (~15 lines) with a double-next guard,
  cheap-reject-first (IP-keyed before body+DB, account-keyed after auth).
- **Two-tier rate limiter** (tier-1 in-memory IP gate first; tier-2 global-keyed atomic
  UPSERT in `ratelimit_db.ts`), limiter return-shape boolean -> `{remaining,resetSeconds}`;
  `authThrottled` genuinely cannot be pre-handler middleware.
- **reqId via built-in `node:async_hooks` AsyncLocalStorage** (stable since v16.4.0, zero
  deps), echoed as `X-Request-Id` on every response, behind a pino-shaped logger facade;
  full OpenTelemetry deferred; `prom-client` only when `/metrics` lands.
- **BOLA via a load-then-authorize `requireOwned*` loader** (scope-before-find,
  account-scoped query) + a deny-by-default coverage test + structured deny logging;
  session-id == request-id comparison is explicitly insufficient.
- **Top-level security-headers wrapper** on the createServer prefix ladder (not just the
  JSON onion), NO COEP:require-corp, full CSP deferred to a Report-Only effort.
- **The World Market realm-scope bug is real** (exactly two writers of the bare `'market'`
  key + a global read sharing one PRIMARY-KEY row; realms on one DATABASE_URL collide
  last-writer-wins). The em-dash fix is matcher-safe; the draft-11
  RateLimit/RateLimit-Policy header syntax (q/w/r/t) is a non-final Internet-Draft to pin
  with a version comment.

## OPEN items + known gotchas
- **Stale anchors.** Every main.ts/db.ts line anchor in the SPEC is stale (main.ts ~1695
  lines). Re-anchor on symbol names and route strings, never line numbers. Phase 03 does the
  re-inventory + a route-count freshness gate; the market/em-dash fixes anchor on function
  names and the literal strings.
- **Non-JSON `/api` classification.** A blanket 415 + JSON-only `withBody` + blanket
  problem+json would break `POST /api/card` (binary) and
  `GET /api/auth/discord/callback` (text/html bounce, not a 302; the only /api HTML route).
  (`GET /api/email/unsubscribe` + `GET /api/account/email/verify` answer application/json, so they do
  not break the blanket; Phase 3 QA corrected an initial HTML misclassification.) Classify by response content-type; ship a
  `withRawBody` variant; exempt declared non-JSON routes; 415 log-only first until native
  (Capacitor) traffic confirmed. Design task that must PRECEDE the error-model phase.
- **compose-no-auto-respond rule.** `compose()` returns a promise and does NOT send a
  response or catch on its own; raw `node:http` leaves the socket hanging on an uncaught
  throw. `withErrors` must be OUTERMOST AND the top-level `compose(ctx)` call must be wrapped
  to guarantee exactly ONE idempotent response on both the resolve and throw paths
  (headersSent/writableEnded guarded). A top-level `clientError` handler must destroy the
  socket. Mandatory, not optional.
- **Perf/tick gate X-ms TBD.** The acceptance constant (pipeline adds < X ms p99; tick p95
  stays under 0.8 x DT) is not yet picked. Phase 24 codifies the gate and chooses X against
  the existing perf harness.
- **Old-ladder deletion exit criteria TBD.** "Next release once metrics are clean" is
  unresolved: which metrics, what thresholds, who owns the call, what if v0.18 ships before
  they are clean. Phase 25 names the metric gate (e.g. zero `http_requests_total` on the
  old-path label for N days, zero unexplained 404 delta) + an owner; the deletion is its own
  follow-up PR.
- **Rollback tradeoff accepted.** A flag flip reverts the hardening too (the suite targets
  the new path). This is the chosen model; not an open question, but keep it visible.
- **`handleSwagClaim` orphaned.** Implemented + tested in `discord.ts` but never dispatched;
  Phase 16 wires it.
- **DISCORD_SCHEMA precedent trap.** Defined-but-unwired on this branch; the exact failure
  mode `RATELIMIT_SCHEMA` must avoid. Always add new schemas to the `ensureSchema` list with
  a boot-time table-existence assertion.
- **`isIpBlocked` + turnstile parity gap** carried forward from prior Discord reviews;
  ported Discord endpoints must not skip those checks.
