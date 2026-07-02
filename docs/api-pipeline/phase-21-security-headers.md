# Phase 21: Security headers top-level wrapper + Content-Type/Origin enforcement

Phase 21 is the cross-cutting hardening phase in the API Pipeline stacked-PR chain. It adds the
one piece of defense-in-depth that must span the WHOLE `createServer` prefix ladder rather than a
single domain: a `withSecurityHeaders` wrapper covering static, SSR, card, avatar, sitemap, the
OAuth GET pages AND the route onion, plus a log-only Content-Type 415 gate on the `/api` JSON
surface and a cheap Origin/Sec-Fetch-Site check on mutating endpoints. It is sized to stay under
40% context because it ships zero DDL, zero JSONB change, no WS wire change, and touches no
per-domain handler logic: it is one top-level wrapper module plus two small middlewares that read
the content-type classification already frozen in Phase 3, with at most two append-only error
codes. The load-bearing constraint is placement: the wrapper sits TOP-LEVEL so a routing
rollback (flag off, old ladder active) can never drop the headers. Read the canonical decisions in
`docs/api-pipeline/` planning state before starting; this file is the executable contract.

### Starter Prompt

````
This is Phase 21 of the API Pipeline re-architecture: Security headers top-level wrapper plus
Content-Type/Origin enforcement.
Model: Opus 4.8, xhigh effort. Harness: Claude Code.
ULTRACODE: this phase is NOT batch-heavy (one wrapper module plus two small middlewares and their
tests, no large content/test sweep). Do NOT add `ultracode`; hand-spawn 2 to 3 parallel Agents as
described in STEP 2.
Goal: add a top-level withSecurityHeaders wrapper that sets hardening headers across the entire
createServer prefix ladder AND the route onion on BOTH the old and new dispatch paths, plus a
log-only Content-Type 415 gate and a cheap cross-site Origin check, without setting COEP or any
enforcing CSP and without breaking the binary card upload, the HTML pages, the redirect callback,
the beacons, or native/cross-realm clients.

STEP 0 - PRE-FLIGHT
- Run `git status`. The worktree is SHARED with concurrent sessions: if it is dirty with files you
  do not own, STOP and ask before staging anything. You will commit with EXPLICIT paths only, never
  `git add -A`.
- Scan Claude Code memory for entries in this phase's domain. Suggested topics to look up:
  "API pipeline phase 9 top-level CORS wrapper + dispatcher", "security headers / HSTS / COEP / CSP",
  "Capacitor native client + cross-realm origins", "content-type classification phase 3 (binary card,
  HTML unsubscribe, discord redirect, beacons)". Surface anything relevant before you design the wrapper.

STEP 1 - LOAD CONTEXT (do NOT read planning docs or large source files directly; spawn ONE Explore agent)
Tell the Explore agent to summarize, anchored on SYMBOL NAMES and route/prefix strings (main.ts is
~1695 lines, every SPEC line anchor is stale), and to return symbol-anchored summaries, never verbatim
dumps:
- docs/api-pipeline/state.md and docs/api-pipeline/progress.md (the running ledger: what Phases 1 to 20
  shipped, the exact name of the single dispatch flag env var, where the Phase 9 TOP-LEVEL CORS +
  OPTIONS-204 wrapper sits in the createServer callback, the RouteDef metadata shape, and the Phase 3
  per-route content-type classification, JSON vs HTML vs redirect vs binary vs the {ok:false} 405).
- docs/api-pipeline/phase-21-security-headers.md (this file).
- The createServer top-level callback in server/main.ts, anchored on the prefix dispatch: serveStatic,
  the /c/ SSR route, the /p/ card route, /avatar, the sitemap route, and how the request reaches either
  the old handleApi ladder OR the new dispatcher. Return the EXACT seam where the Phase 9 CORS wrapper
  is applied (this phase mirrors that placement) and where the WS upgrade handshake is wired (the
  wrapper must not touch the upgrade response).
- The OAuth GET page handlers in server/oauth.ts, anchored on handleOAuth and the consent/device HTML
  pages plus htmlError, and the auth/token POST responses (so the runner knows which responses get
  frame-ancestors/X-Frame-Options and which get Cache-Control: no-store).
- The Phase 8/9 spine the wrapper and middlewares consume: server/http/compose.ts, context.ts,
  registry.ts, index.ts, error_codes.ts, and server/http/middleware/*.ts (esp. withErrors, withCors,
  withBody/withRawBody and how the body middleware reads a route's content-type classification). Return
  the RouteDef metadata fields that carry the per-surface content-type, how a middleware reads ctx +
  the matched route, and the append-only error_codes.ts pattern.
- The current process.env reads for production detection (HSTS-in-prod), the realm origins, and the
  native-app (Capacitor) origins, anchored on their symbol names (the Phase 24 loadConfig may not exist
  yet; if it does, read origins/prod through it, otherwise read them where they are read today).
- server/CLAUDE.md and root CLAUDE.md (the server/http seam + invariants).
Explore should RETURN: the exact createServer prefix-dispatch seam + the Phase 9 CORS-wrapper placement
to mirror, the OAuth GET/auth-token response sites, the RouteDef content-type-classification metadata
and how to read it from a middleware, the error_codes.ts append pattern, and the prod/realm/native-origin
config reads, so STEP 2 agents need nothing else.

STEP 2 - CHOOSE ORCHESTRATION + EXECUTE
Phase 21 has NO documented a/b split (only 08, 09, 17, 23 do): keep all three slices in ONE PR.
Hand-spawn these parallel Agents, each owning a COMPLETE vertical slice (behavior + its tests). Give
each agent ONLY the Explore summary, not the planning docs.
- Agent A (the top-level wrapper): server/http/middleware/security_headers.ts plus its wiring.
  - Implement withSecurityHeaders as a TOP-LEVEL wrapper on the createServer prefix ladder (mirror the
    Phase 9 CORS wrapper's placement) so it covers serveStatic, /c/ SSR, /p/ card, /avatar, the sitemap,
    the OAuth GET pages AND the route onion, on BOTH the old handleApi ladder and the new dispatcher.
  - Set: X-Content-Type-Options: nosniff; a Referrer-Policy; a Permissions-Policy deny-all; HSTS ONLY
    in production (HTTPS); Cross-Origin-Opener-Policy same-origin; Cross-Origin-Resource-Policy
    same-origin; strip Server and X-Powered-By. Apply frame-ancestors/X-Frame-Options ONLY to the OAuth
    pages (and any other framable HTML you confirm), and Cache-Control: no-store ONLY to auth/token
    responses. Set headers BEFORE the response is written so they are present on success AND error.
  - Explicitly do NOT set Cross-Origin-Embedder-Policy: require-corp (it would break cross-origin
    GLB/HDRI loads) and do NOT add any enforcing Content-Security-Policy (full CSP is a separate
    Report-Only effort, out of scope). Do NOT touch the WS upgrade handshake response.
  - Every header value is a NAMED constant with a single source of truth. Tests assert presence on a
    static path, an SSR path, an OAuth GET page, and an /api route; assert NO COEP and NO enforcing CSP;
    assert HSTS appears only under the prod flag; assert the OAuth-only frame headers and auth-only
    no-store.
- Agent B (Content-Type 415, LOG-ONLY first): server/http/middleware/content_type.ts.
  - Enforce Content-Type: application/json on /api JSON request bodies, but ship in LOG-ONLY mode by
    default behind a NAMED flag (a structured log/metric via the Phase 8 injectable sink or the existing
    console facade, NOT the Phase 23 logger; it records the mismatch and PASSES the request through).
  - EXEMPT every declared non-JSON route via the Phase 3 content-type classification: the binary card
    upload, the HTML email/unsubscribe page, the Discord redirect callback, and any beacon endpoint
    (site-presence, perf-report) whose audited Content-Type is not application/json. Read the
    classification from the matched RouteDef metadata; do NOT hardcode a path list. DELEGATE-SERVED
    CARVE-OUT: a route with no RouteDef (any 18b remainder plus the deliberately off-table shapes:
    the oauth GET HTML pages, HEAD-to-GET, the daily-rewards prefix-arm oddities) never matches, so
    the 415 and Origin gates cannot see it; enforcement flips only cover the registered surface.
    Land Phase 18b BEFORE flipping enforce mode, or record the uncovered delegate set with the flag.
  - Flipping the flag to ENFORCE returns 415 (Unsupported Media Type) with a STABLE CODE on a wrong
    Content-Type for a JSON route. Append the code to error_codes.ts (frozen, append-only) and add its
    English apiError.* catalog entry in the SAME change. Tests cover: log-only passes through and emits
    the sink record; exempt routes are never gated in either mode; enforce mode returns 415 + the code
    on a wrong type and 2xx on application/json.
- Agent C (cheap Origin/Sec-Fetch-Site check on mutating endpoints): server/http/middleware/origin_check.ts.
  - On mutating methods only (POST/PUT/PATCH/DELETE), reject a CLEAR cross-site request: when an Origin
    (or Sec-Fetch-Site) header is present and is NOT same-origin and NOT in the allowlist, reject with a
    STABLE CODE. The allowlist is same-origin plus the configured realm origins plus the native-app
    (Capacitor) origins, read from config as NAMED values.
  - An ABSENT Origin is ALLOWED (the surface is bearer-only with no cookies, so beacons and native
    clients that send no Origin must still work). Mirror Agent B: ship this LOG-ONLY first behind a
    named flag if there is ANY doubt about native/beacon Origin behavior, flipping to enforce only after
    the audit; default to the safer of (log-only) until native traffic is confirmed.
  - Append the cross-site error code to error_codes.ts (frozen, append-only) with its English apiError.*
    catalog entry. Tests cover: same-origin allowed, allowlisted realm/native origin allowed, absent
    Origin allowed, a clear cross-site Origin rejected (or logged in log-only mode), GET/HEAD never gated.
If context approaches 40% despite the small surface, reduce fan-out detail and lean on the Phase 9
parity harness rather than splitting the PR; this phase ships as one PR.

INVARIANTS THIS PHASE MUST KEEP
- TOP-LEVEL wrapper covering BOTH paths (CENTRAL here): per the locked decision, the security-headers
  wrapper stays a TOP-LEVEL createServer wrapper alongside the Phase 9 CORS wrapper, covering the old
  handleApi ladder AND the new dispatcher. A dispatch flag-flip (old ladder active) must NOT drop a
  single security header. It is NOT inside the per-route onion only.
- Single-flag dispatch + per-path catch-all delegate: this phase adds NO new dispatch branching; it
  wraps the existing one. Do not change which path serves a route.
- Server-authority: the server emits a stable CODE on any rejection, never English prose. The 415 code
  and the cross-site code are new APPEND-ONLY entries in server/http/error_codes.ts reusing the existing
  domain.reason vocabulary, each with an English apiError.* catalog entry added in the SAME change. Do
  NOT edit the userFacingApiError client matcher in src/main.ts: that extension is Phase 22.
- No magic values: every header value, the log-only flags, the prod detection, and the origin allowlist
  are NAMED constants or config reads with a single source of truth.
- No persistence change: no DDL, no ALTER, no JSONB shape change, no new table (no migration-safety surface).
- Determinism / sim-purity: this work is SERVER-ONLY. Do NOT import from or touch src/sim/; if you reach
  for it, stop.
- No WS wire change. No em dashes, no en dashes, no emojis anywhere (code, comments, commits, docs).

OUT OF SCOPE (do not touch; each is a later phase or an explicit deferral)
- The full Content-Security-Policy, even Report-Only: explicitly deferred to a separate effort. Do NOT
  add any CSP header here.
- Cross-Origin-Embedder-Policy: require-corp: explicitly NOT set (would break cross-origin GLB/HDRI).
- The userFacingApiError client matcher extension + the per-surface code-parity guard in src/main.ts
  (Phase 22): add the server CODE and the English apiError.* entry only; do NOT edit the client matcher.
- The structured logger + /metrics exporter + drain-aware health (Phase 23): the 415/Origin log-only
  records use the Phase 8 injectable sink or the existing console facade, NOT a new logger.
- Validated config + server timeouts + no-magic-values consolidation (Phase 24): read prod/realm/native
  origins where they are read today (or the Phase 24 loadConfig if it already exists); do NOT consolidate
  config or set server timeouts here.
- CORS itself: the top-level CORS + OPTIONS-204 wrapper already exists (Phase 9). Do NOT re-implement
  CORS; only add the security-headers wrapper alongside it and mirror its placement.
- Rate-limiter rework (Phase 19), market realm-scope fix (Phase 20), flag-default flip (Phase 25), and
  every per-domain handler migration (Phases 10 to 18 plus the 18b late arrivals).

STEP 3 - VALIDATION + MULTI-AGENT REVIEW
Validation (server-only code change that adds player-facing codes):
- `npx tsc --noEmit`
- `npx vitest run tests/server/http/security_headers.test.ts` plus the new content_type and origin_check
  test files, and any existing server suite the wrapper wiring touches.
- The Phase 9 dual-path PARITY harness over the Phase 3 fixtures: the security headers MUST appear
  identically on BOTH the old-ladder and new-dispatcher passes for every surface (static/SSR/OAuth-GET/
  /api). The new headers are a LABELED knownDeviation: update the fixtures' contracted-header set and add
  the asserted-knownDeviation entry, never a silent parity diff. Assert a simulated flag-off (old ladder)
  pass STILL carries every header.
- `npx vitest run tests/localization_fixes.test.ts` (S3) plus the per-surface code-parity assertion if it
  already exists (the 415 + cross-site codes must resolve).
- `npm run ci:changed` (Biome on changed files; scoped `npx @biomejs/biome check --write <file>` only).
- `npm run build:server`.
- Full pre-merge gate before opening the PR: `npm test && npx tsc --noEmit && npm run build:env &&
  npm run build:server && npm run build`.
Multi-agent review (spawn ONLY the agents whose surface this diff touches; check `git diff --name-only`):
- privacy-security-review: REQUIRED (this IS the security-headers + content-type + origin phase). Prompt
  it for COVERAGE not filtering: verify header completeness and correctness (nosniff, Referrer-Policy,
  Permissions-Policy deny-all, HSTS prod-only, COOP/CORP same-origin, OAuth frame headers, auth no-store,
  Server/X-Powered-By stripped), that COEP and an enforcing CSP are absent, that the 415 ships log-only
  and exempts non-JSON routes, that the Origin check allows absent-Origin and allowlisted realm/native
  origins, and that no rejection leaks internals or breaks a native/cross-realm/beacon client.
- migration-safety: SKIP (no DDL, no JSONB change, no db.ts change).
- cross-platform-sync: SKIP (no IWorld/src/sim/wire/sim_i18n/server_i18n/RL change). NOTE: the
  native-client risk (Capacitor Origin + Content-Type) is real but server-only; fold it into the
  privacy-security-review prompt rather than dispatching cross-platform-sync.
- architecture-reviewer: SKIP (no src/sim change).
- qa-checklist at phase completion.
Give each reviewer this truncation-resume line: "If your review is truncated, note exactly where you
stopped and resume from that point in a follow-up pass; do not silently drop coverage." Do NOT commit
the PR-final state until every dispatched reviewer reports no BLOCKING finding.

STEP 4 - COMMIT CADENCE (Conventional Commits, scope, EXPLICIT paths; this phase ships as its OWN green PR)
- feat(http): top-level withSecurityHeaders wrapper over the createServer prefix ladder
  (server/http/middleware/security_headers.ts, server/main.ts)
- feat(http): OAuth frame headers and auth/token no-store specializations
  (server/http/middleware/security_headers.ts, server/oauth.ts)
- feat(http): log-only Content-Type 415 gate exempting non-JSON routes
  (server/http/middleware/content_type.ts, server/http/error_codes.ts)
- feat(http): cheap cross-site Origin check on mutating endpoints
  (server/http/middleware/origin_check.ts, server/http/error_codes.ts)
- test(server): security-header, content-type, and origin parity and unit coverage
  (tests/server/http/security_headers.test.ts, the content_type + origin_check tests, the updated Phase 3 fixtures)
Each phase is a bisectable PR; the suite stays green at every commit.

STEP 5 - ACCEPTANCE CRITERIA (verifiable checkboxes)
- [ ] withSecurityHeaders is a TOP-LEVEL createServer wrapper covering serveStatic, /c/ SSR, /p/ card,
      /avatar, the sitemap, the OAuth GET pages AND the route onion; it is present on BOTH the old-ladder
      and new-dispatcher paths and a simulated flag-off pass still carries every header.
- [ ] Headers set: X-Content-Type-Options: nosniff; a Referrer-Policy; a Permissions-Policy deny-all;
      HSTS in production only; COOP same-origin; CORP same-origin; frame-ancestors/X-Frame-Options on the
      OAuth pages; Cache-Control: no-store on auth/token responses; Server + X-Powered-By stripped.
- [ ] COEP: require-corp is NOT set (cross-origin GLB/HDRI still load) and NO enforcing CSP header is present.
- [ ] Content-Type 415 gate runs in LOG-ONLY mode by default behind a named flag; binary (card), HTML
      (email/unsubscribe), redirect (discord callback), and audited beacon routes are EXEMPT via the
      Phase 3 content-type classification; flipping the flag to enforce returns 415 + a stable code on a
      wrong Content-Type and 2xx on application/json.
- [ ] The mutating-endpoint Origin check rejects a clear cross-site Origin with a stable code, allows
      same-origin + allowlisted realm/native origins, and ALLOWS an absent Origin; GET/HEAD are never gated.
- [ ] Each new error code (unsupported-media-type, cross-site-origin) is appended to error_codes.ts
      frozen append-only with an English apiError.* catalog entry; src/main.ts userFacingApiError is NOT touched.
- [ ] All header values, the log-only flags, the prod detection, and the origin allowlist are named
      constants / config reads; no magic literals.
- [ ] The dual-path parity harness is green: headers present identically on old + new paths, the new
      headers a labeled knownDeviation with fixtures updated.
- [ ] tsc clean, S3 green, ci:changed clean, build:server green, full pre-merge gate green.
- [ ] No DDL; no WS wire change; no em/en dashes or emojis; no src/sim touch.

STEP 6 - DOC UPDATES + MEMORY
- Update docs/api-pipeline/progress.md: mark Phase 21 done; name the new modules
  (server/http/middleware/security_headers.ts, content_type.ts, origin_check.ts), the header set and the
  explicit NO-COEP / NO-CSP decision, the log-only flags, the two appended error codes (unsupported-media-type,
  cross-site-origin) + their apiError.* entries, and the top-level-wrapper-covers-both-paths invariant.
- Update docs/api-pipeline/state.md: security headers now span the full prefix ladder on both dispatch
  paths; the 415 and Origin checks are log-only pending the native-traffic audit.
- Record surprising rules in Claude Code memory: why the wrapper is top-level not onion (a flag-flip must
  not drop headers), why COEP is excluded (cross-origin GLB/HDRI), why 415 + Origin ship log-only first
  (unconfirmed Capacitor traffic), and the absent-Origin allowance (bearer-only, no cookies).

STEP 7 - FINAL RESPONSE FORMAT
- Phase status (DONE / BLOCKED), files touched (absolute paths), validation results (each command +
  pass/fail), review verdicts (per dispatched reviewer), explicit deferrals, and a one-line handoff:
  "Ready for Phase 21 QA."

STOPPING RULES
- STOP if the security-headers wrapper ends up inside the per-route onion only: it MUST be top-level and
  cover both the old ladder and the new dispatcher (a routing rollback must not drop any header).
- STOP if a simulated dispatch flag-flip (old ladder active) drops any security header.
- STOP if COEP: require-corp gets set, or any enforcing Content-Security-Policy header is added (both out
  of scope; both would break cross-origin assets or the client).
- STOP if the 415 gate ships in ENFORCE mode rather than LOG-ONLY (native Capacitor traffic is unconfirmed).
- STOP if the 415 or Origin check would reject the binary card upload, the HTML email/unsubscribe page,
  the Discord redirect callback, a beacon (site-presence/perf-report), or a native/cross-realm client.
- STOP if any new player-facing rejection emits English prose instead of a stable code, or if you edit
  userFacingApiError in src/main.ts (Phase 22).
- STOP if the wrapper alters or sets headers on the WS upgrade handshake response.
- STOP if any change would alter the WS wire protocol, touch src/sim/ (determinism/sim-purity), or add DDL.
````
