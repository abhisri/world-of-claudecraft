// Phase 9 old-vs-new /api dispatch parity (docs/api-pipeline/phase-09-registry-parity.md).
//
// This harness proves the new in-house /api dispatcher is byte-for-byte identical
// to today. It replays a corpus of /api requests through routeHttpRequest under
// BOTH dispatch modes in-process (the API_DISPATCH flag forced to 'legacy' then
// to 'new' via the test-only setter) and diffs status + normalized body +
// contracted headers with the shared runParity driver.
//
// The parity contract as routes migrate: an un-migrated /api path still delegates
// to the legacy handleApi ladder UNCHANGED, so old and new resolve through the
// exact same handler and are byte-identical. A migrated route is byte-identical
// too UNLESS it carries a labeled known deviation. Phase 10 (public reads) is the
// first migration and lands two deviations: the /api/status name-list trim and the
// /api/realms + /api/search authz-gap-close. So the raw old-vs-new divergence list
// is no longer empty; the known-deviations filter removes exactly those, and any
// residual divergence is a real parity break.
//
// Determinism rules this file obeys (mirrors characterization.test.ts):
//   - It replays ONLY the db-free CONTRACT requests characterization.test.ts uses
//     for the MAIN /api surface (requests that return BEFORE any pool.query). The
//     pool-less test DATABASE_URL makes any db-touching arm either hang the poller
//     or return a pool-500 artifact, neither of which is the route contract, so
//     those db-dependent success paths are deliberately excluded (see SKIP notes
//     at the bottom).
//   - runParity resets every limiter bucket + the ratelimit clock + auth-failure
//     bucket before EACH dispatcher pass, so a limiter tripped on the old pass can
//     never bleed into the new pass and falsely register as a divergence. The
//     named-assertion captures below reuse the same per-pass isolation.
//   - The GitHub releases proxy does a network fetch; it is pinned deterministic
//     by stubbing global fetch to reject (the real graceful-degradation contract:
//     an unreachable GitHub yields an empty feed), exactly as characterization does.
//   - The /api/perf dev gate is forced OFF (ALLOW_DEV_COMMANDS='0') so GET /api/perf
//     deterministically falls through to the 404 unknown-endpoint arm on both passes.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resetAuthFailures,
  resetCardUploadRateLimits,
  resetCharacterMutationRateLimits,
  resetDiscordRateLimits,
  resetPublicReadRateLimits,
  resetRateLimitClock,
  resetRateLimits,
  resetReportsCreateRateLimits,
  resetWalletLinkRateLimits,
  resetWocBalanceRateLimits,
} from '../../../server/ratelimit';
import { NATIVE_APP_ORIGINS } from '../../../server/web_login_guard';
import {
  captureResponse,
  type Dispatch,
  makeReq,
  normalizeResponse,
  type ParityFixture,
  type ParityReport,
  runParity,
  stableStringify,
} from '../helpers';
import { KNOWN_DEVIATIONS } from './known_deviations';

// db.ts reads DATABASE_URL at module scope (throws if unset); a dummy URL lets the
// bare server/main import resolve. The pool is constructed but never connects, so
// every contract request replayed here returns before touching it.
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5433/wocc_phase9_parity';

// routeHttpRequest is synchronous fire-and-forget (void apiEntry(req, res)), so a
// dispatch must poll res.writableEnded before the captured triple is readable.
const MAX_POLL_TICKS = 5000;
// The /api/perf dev gate reads process.env.ALLOW_DEV_COMMANDS per request.
const DEV_COMMANDS_ENV = 'ALLOW_DEV_COMMANDS';
// Content-Length header sentinel: far above the player-card byte cap, so the
// pre-auth 413 fires before any db read.
const HEADER_CONTENT_LENGTH = 'content-length';
const OVERSIZE_CONTENT_LENGTH = '999999999';
// A CORS Origin the server reflects: a genuine member of the native-app allowlist,
// which maybeCors reflects regardless of the REALMS env (REALM_ORIGINS is empty in
// tests). Read from the source set so a change to the allowlist keeps the test honest.
const REFLECTED_ORIGIN = [...NATIVE_APP_ORIGINS][0];
// A public-cors path: isPublicCorsPath('/api/public/...') is true, so
// applyCorsAndPreflight applies the wide-open '*'. No /api/public/* handler exists,
// so the request also exercises the db-free 404 unknown-endpoint fallthrough.
const PUBLIC_CORS_PATH = '/api/public/does-not-exist';
// A representative non-public /api route, used for the reflected-origin and the
// preflight CORS assertions.
const REPRESENTATIVE_API_PATH = '/api/characters';

// A single request spec: the source of both a ParityFixture (name + factory) and
// the fixture-name -> request-path map used to match against KNOWN_DEVIATIONS.
interface ApiRequestSpec {
  name: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

// The db-free MAIN /api contract corpus. Each entry mirrors a specific it-block in
// tests/server/http/characterization.test.ts (the fixture name matches the golden
// name there), with the four dedicated CORS/preflight cases added on top. Error
// paths and the 404-vs-405 fallthroughs are included in full (weighted heaviest by
// the diff), since those are where a future migration is most likely to drift.
const API_REQUEST_CORPUS: readonly ApiRequestSpec[] = [
  // --- preflight + dispatcher fallthrough (characterization block 1) ---------
  { name: 'options_login_204', method: 'OPTIONS', url: '/api/login' },
  { name: 'site_presence_get_405', method: 'GET', url: '/api/site-presence' },
  { name: 'unknown_endpoint_404', method: 'GET', url: '/api/this-route-does-not-exist' },
  // GET /api/perf with the dev gate off (forced in beforeAll) is a 404.
  { name: 'perf_devgate_off_404', method: 'GET', url: '/api/perf' },

  // --- public read contracts, no db / empty cache (characterization block 2) --
  { name: 'status_get', method: 'GET', url: '/api/status' },
  { name: 'realms_get_noauth', method: 'GET', url: '/api/realms' },
  {
    name: 'native_attestation_challenge_post',
    method: 'POST',
    url: '/api/native-attestation/challenge',
    body: {},
  },

  // --- GitHub releases proxy, network stubbed to empty (characterization block 3)
  { name: 'releases_get_empty', method: 'GET', url: '/api/releases' },

  // --- leaderboard payload shapes, empty cache (characterization block 4) ------
  { name: 'leaderboard_default', method: 'GET', url: '/api/leaderboard' },
  { name: 'leaderboard_guilds', method: 'GET', url: '/api/leaderboard?board=guilds' },
  // ?board=devs (open-source contributor board, added by the release/v0.18.0 merge):
  // fetch is disabled in this harness so topContributors yields an empty snapshot on
  // BOTH passes, proving the migrated leaderboardHandler devs fork is byte-identical
  // to the legacy handleApi arm.
  { name: 'leaderboard_devs', method: 'GET', url: '/api/leaderboard?board=devs' },
  { name: 'leaderboard_scope_global', method: 'GET', url: '/api/leaderboard?scope=global' },
  { name: 'leaderboard_scope_realm', method: 'GET', url: '/api/leaderboard?scope=realm' },
  { name: 'leaderboard_limit5', method: 'GET', url: '/api/leaderboard?limit=5' },
  // HEAD parity: the Phase 4 router synthesizes HEAD from GET, but the dispatcher
  // delegates a HEAD match to the legacy ladder (which 404s HEAD) so HEAD stays
  // byte-identical old-vs-new while the legacy arms are retained (serving HEAD as
  // GET is deferred to the Phase 25 flag flip). This pins it: a HEAD to a migrated
  // GET route must 404 on BOTH paths, with no divergence and no known-deviation.
  { name: 'leaderboard_head_404', method: 'HEAD', url: '/api/leaderboard' },

  // --- binary request class, player card (characterization block 5) -----------
  {
    name: 'card_too_large_413',
    method: 'POST',
    url: '/api/card',
    headers: { [HEADER_CONTENT_LENGTH]: OVERSIZE_CONTENT_LENGTH },
  },

  // --- email link endpoints, public, no token = no db (characterization block 6)
  { name: 'email_unsubscribe_no_token', method: 'GET', url: '/api/email/unsubscribe' },
  { name: 'email_verify_no_token_400', method: 'GET', url: '/api/account/email/verify' },

  // --- wrong-method fallthrough, planned 405 baseline (characterization block 7)
  { name: 'register_get_wrong_method_404', method: 'GET', url: '/api/register' },
  {
    name: 'me_characters_post_wrong_method_404',
    method: 'POST',
    url: '/api/me/characters',
    body: {},
  },

  // --- Discord contract paths, unconfigured / no auth (characterization block 8)
  {
    name: 'discord_start_unconfigured_503',
    method: 'POST',
    url: '/api/auth/discord/start',
    body: {},
  },
  { name: 'discord_status_get_noauth_401', method: 'GET', url: '/api/discord' },
  { name: 'discord_unlink_delete_noauth_401', method: 'DELETE', url: '/api/discord' },
  {
    name: 'discord_callback_error_bounce',
    method: 'GET',
    url: '/api/auth/discord/callback?code=x&state=y',
  },

  // --- bearer-auth denial contracts, no Authorization (characterization block 9)
  { name: 'characters_get_noauth_401', method: 'GET', url: '/api/characters' },
  { name: 'me_characters_get_noauth_401', method: 'GET', url: '/api/me/characters' },
  { name: 'account_get_noauth_401', method: 'GET', url: '/api/account' },
  { name: 'account_logout_post_noauth_401', method: 'POST', url: '/api/account/logout', body: {} },
  { name: 'wallet_get_noauth_401', method: 'GET', url: '/api/wallet' },
  { name: 'referrals_get_noauth_401', method: 'GET', url: '/api/referrals' },
  { name: 'reports_post_noauth_401', method: 'POST', url: '/api/reports', body: {} },
  // Phase 10 authz-gap-close: /api/search is now anonymous-friendly, so a no-token
  // request serves 200 { results: [] } (empty query) instead of the legacy 401.
  // The query is intentionally dropped so the served path stays db-free (a
  // non-empty ?q would reach searchCharacters); old 401 vs new 200 is the
  // realmsSearchAuthzGapClose deviation the filter below expects.
  { name: 'search_get_noauth', method: 'GET', url: '/api/search' },
  { name: 'owner_sheet_get_noauth_401', method: 'GET', url: '/api/characters/1/sheet' },
  { name: 'standing_get_noauth_401', method: 'GET', url: '/api/characters/1/standing' },

  // --- register + login validation, empty body, pre-db (characterization block 10)
  { name: 'register_post_empty_400', method: 'POST', url: '/api/register', body: {} },
  { name: 'login_post_empty_401', method: 'POST', url: '/api/login', body: {} },

  // --- dedicated CORS / preflight cases (added on top of the characterization set)
  // A GET to a non-public /api route WITH a reflected Origin: exercises maybeCors's
  // reflected Access-Control-Allow-Origin + Vary on a real response body.
  {
    name: 'cors_reflected_origin_get',
    method: 'GET',
    url: '/api/status',
    headers: { origin: REFLECTED_ORIGIN },
  },
  // A GET to a public-cors path: exercises the wide-open '*' plus the 404 fallthrough.
  { name: 'cors_public_wildcard_get', method: 'GET', url: PUBLIC_CORS_PATH },
  // OPTIONS preflight WITH Origin + Access-Control-Request-Method for an /api path:
  // the 204 short-circuit plus the reflected CORS header set.
  {
    name: 'cors_preflight_api_204',
    method: 'OPTIONS',
    url: REPRESENTATIVE_API_PATH,
    headers: { origin: REFLECTED_ORIGIN, 'access-control-request-method': 'GET' },
  },
  // OPTIONS preflight for a public-cors path: the 204 short-circuit plus the '*' set.
  {
    name: 'cors_preflight_public_204',
    method: 'OPTIONS',
    url: PUBLIC_CORS_PATH,
    headers: { origin: REFLECTED_ORIGIN, 'access-control-request-method': 'GET' },
  },
];

// Fixture name -> request path (query stripped), for matching a divergence against
// KNOWN_DEVIATIONS.routes (which are path strings).
const PATH_FOR_FIXTURE = new Map(
  API_REQUEST_CORPUS.map((spec) => [spec.name, spec.url.split('?')[0]]),
);

function specToFixture(spec: ApiRequestSpec): ParityFixture {
  return {
    name: spec.name,
    req: () =>
      makeReq({ method: spec.method, url: spec.url, headers: spec.headers, body: spec.body }),
  };
}

// One request path matches a KNOWN_DEVIATIONS route pattern, treating a ':param'
// segment (e.g. /api/characters/:id/sheet) as a wildcard.
function pathMatchesRoute(actualPath: string, routePattern: string): boolean {
  const actual = actualPath.split('/');
  const pattern = routePattern.split('/');
  if (actual.length !== pattern.length) return false;
  return pattern.every((seg, i) => seg.startsWith(':') || seg === actual[i]);
}

function isKnownDeviationPath(path: string): boolean {
  return KNOWN_DEVIATIONS.some((d) => d.routes.some((route) => pathMatchesRoute(path, route)));
}

// Reset all limiter state + the ratelimit clock, mirroring runParity's per-pass
// isolation so the named-assertion captures below start from clean state too.
function isolate(): void {
  resetRateLimits();
  resetCardUploadRateLimits();
  resetWalletLinkRateLimits();
  resetDiscordRateLimits();
  resetWocBalanceRateLimits();
  resetPublicReadRateLimits();
  // Keep in lockstep with isolatePass: the Phase 12 per-account character-mutation
  // buckets are separate, so a create/rename/delete/takeover 429 on one pass must not
  // bleed into the next (harmless today, since no captureBothModes case mutates).
  resetCharacterMutationRateLimits();
  // The Phase 15 reports.create limiter bucket, likewise (the reports re-pin 401s at
  // activeGuard before the limiter, so this is lockstep hygiene, not load-bearing).
  resetReportsCreateRateLimits();
  resetAuthFailures();
  resetRateLimitClock();
}

type MainModule = typeof import('../../../server/main');

// A Dispatch that BAKES IN the /api dispatch mode: it flips the flag (legacy vs
// new) via the test-only setter, drives the real routeHttpRequest, then polls
// res.writableEnded (routeHttpRequest is synchronous fire-and-forget).
function makeModedDispatch(main: MainModule, mode: 'legacy' | 'new'): Dispatch {
  return async (req, res) => {
    main.setApiDispatchModeForTests(mode);
    main.routeHttpRequest(req, res);
    let ticks = 0;
    while (!(res as unknown as { writableEnded: boolean }).writableEnded) {
      if (ticks++ > MAX_POLL_TICKS) throw new Error('response never ended');
      await new Promise((r) => setImmediate(r));
    }
  };
}

let oldDispatch: Dispatch;
let newDispatch: Dispatch;
let report: ParityReport;
let savedDevCommands: string | undefined;

// Capture one fixture request through BOTH modes, each preceded by a full limiter
// reset, and return the two normalized responses for a focused named assertion.
async function captureBothModes(reqFactory: () => ReturnType<typeof makeReq>): Promise<{
  oldCap: ReturnType<typeof normalizeResponse>;
  newCap: ReturnType<typeof normalizeResponse>;
}> {
  isolate();
  const oldCap = normalizeResponse(await captureResponse(oldDispatch, reqFactory()));
  isolate();
  const newCap = normalizeResponse(await captureResponse(newDispatch, reqFactory()));
  return { oldCap, newCap };
}

beforeAll(async () => {
  // Force the /api/perf dev gate off so GET /api/perf is a deterministic 404.
  savedDevCommands = process.env[DEV_COMMANDS_ENV];
  process.env[DEV_COMMANDS_ENV] = '0';
  // Pin the GitHub releases proxy deterministic (unreachable GitHub -> empty feed).
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled for parity harness')));

  const main = (await import('../../../server/main')) as MainModule;
  oldDispatch = makeModedDispatch(main, 'legacy');
  newDispatch = makeModedDispatch(main, 'new');

  const fixtures = API_REQUEST_CORPUS.map(specToFixture);
  report = await runParity({ oldDispatch, newDispatch, fixtures });
});

afterAll(async () => {
  const main = (await import('../../../server/main')) as MainModule;
  main.resetApiDispatchModeForTests();
  vi.unstubAllGlobals();
  if (savedDevCommands === undefined) delete process.env[DEV_COMMANDS_ENV];
  else process.env[DEV_COMMANDS_ENV] = savedDevCommands;
});

describe('/api dispatch parity (legacy flag vs new flag)', () => {
  it('has zero UNEXPECTED divergences across the whole corpus (after the known-deviations filter)', () => {
    // Phase 10 migrates real routes onto the new dispatcher. For an un-migrated or a
    // parity-clean migrated route old-vs-new is byte-identical; the only permitted
    // divergences are the labeled known deviations (the /api/status name-list trim
    // and the /api/realms + /api/search authz-gap-close). A divergence on any other
    // route is a real parity break.
    const unexpected = report.divergences.filter(
      (d) => !isKnownDeviationPath(PATH_FOR_FIXTURE.get(d.fixture) ?? ''),
    );
    expect(unexpected, stableStringify(unexpected, 2)).toEqual([]);
  });

  it('the labeled deviations actually fire (the harness is not silently passing)', () => {
    // Positive control: the /api/status trim and the /api/search authz-gap-close
    // must each produce a raw old-vs-new divergence in the corpus, so the filtered
    // assertion above is meaningfully green rather than green because nothing ran.
    // (/api/realms does not appear here: its no-token body is unchanged; only a
    // present-invalid token, which this db-free corpus does not exercise, differs.)
    const deviatingPaths = new Set(
      report.divergences.map((d) => PATH_FOR_FIXTURE.get(d.fixture) ?? ''),
    );
    expect(deviatingPaths.has('/api/status'), stableStringify(report.divergences, 2)).toBe(true);
    expect(deviatingPaths.has('/api/search'), stableStringify(report.divergences, 2)).toBe(true);
    // Every raw divergence is a registered known-deviation path (no stray break).
    for (const path of deviatingPaths) {
      expect(isKnownDeviationPath(path), `unexpected divergence on ${path}`).toBe(true);
    }
  });

  // The wrong-method 405 { ok: false } heartbeat contract. NOTE on the request:
  // the perf-report/site-presence 405 { ok: false } shape is the shared
  // perfReportSitePresence405OkFalse deviation over BOTH /api/perf-report and
  // /api/site-presence. The db-free representative is GET /api/site-presence: it is
  // the exact request characterization uses for site_presence_get_405 and reaches
  // handleSitePresenceHeartbeat, which returns 405 before any db. (A non-POST
  // /api/perf-report instead falls through to the 404 unknown-endpoint arm in
  // main.ts, and a POST /api/perf-report reaches the db, so neither is a db-free
  // 405 contract path.)
  it('the 405 { ok: false } heartbeat contract is identical old-vs-new and is a 405', async () => {
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({ method: 'GET', url: '/api/site-presence' }),
    );
    expect(oldCap.status).toBe(405);
    expect(newCap.status).toBe(oldCap.status);
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('GET /api/perf-report is identical old-vs-new and is a 404 (re-pins the masked /api/perf-report)', async () => {
    // Companion to the site-presence 405 re-pin above. /api/perf-report is listed in three
    // known deviations (perfReport200NotThrottle, perfReportSitePresence405OkFalse, and
    // reportsBodyValidationRemap), so the aggregate path-scoped filter marks the WHOLE
    // /api/perf-report path as a known deviation. A non-POST /api/perf-report is NOT the
    // handler's dead 405 { ok: false } branch: it resolves methodNotAllowed and the new
    // dispatcher delegates it to the legacy ladder, whose dispatch arm gates on POST, so a
    // GET falls through to the 404 unknown-endpoint arm (db-free) exactly as the legacy path
    // does. This dedicated assertion pins that 404 byte-identical on both flags, which the
    // masking would otherwise hide (mirrors the site-presence 405 + reports 401 re-pins).
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({ method: 'GET', url: '/api/perf-report' }),
    );
    expect(oldCap.status).toBe(404);
    expect(newCap.status).toBe(oldCap.status);
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('GET /api/characters with no auth is identical old-vs-new and is a 401', async () => {
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({ method: 'GET', url: '/api/characters' }),
    );
    expect(oldCap.status).toBe(401);
    expect(newCap.status).toBe(oldCap.status);
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('POST /api/reports with no auth is identical old-vs-new and is a 401 (re-pins the masked /api/reports)', async () => {
    // Phase 15 registers POST /api/reports behind the shared legacy-body activeGuard
    // and lists /api/reports in the newLimiterReportsCreate + reportsBodyValidationRemap
    // deviations, which mark the whole path as a known deviation in the aggregate
    // filter. The reports_post_noauth_401 corpus request never reaches the limiter or
    // the body read (activeGuard 401s first, db-free), so it must stay byte-identical
    // old-vs-new; this dedicated assertion re-pins that identity the path-scoped filter
    // would otherwise mask (mirrors the card no-auth 401 re-pin). A no-bearer POST 401s
    // at activeGuard with { error: 'not authenticated' }, byte-identical on both paths.
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({ method: 'POST', url: '/api/reports', body: {} }),
    );
    expect(oldCap.status).toBe(401);
    expect(newCap.status).toBe(oldCap.status);
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('the card pre-auth 413 + Connection: close is identical old-vs-new (re-pins the masked /api/card)', async () => {
    // Phase 14 registers POST /api/card and lists it in the rateLimitedBodyToCode
    // deviation (its 429 body becomes a code), which marks the whole /api/card path
    // as a known deviation in the aggregate filter. The card_too_large_413 corpus
    // request never hits the limiter (it 413s pre-auth on Content-Length), so it must
    // stay byte-identical old-vs-new; this dedicated assertion re-pins that identity
    // the path-scoped filter would otherwise mask (mirrors the characters no-auth
    // re-pin above). The oversize Content-Length trips cardContentLengthGuard on the
    // new path exactly as the legacy pre-auth check does: 413 { error: 'image too
    // large' } with Connection: close, before auth and before any body read.
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({
        method: 'POST',
        url: '/api/card',
        headers: { [HEADER_CONTENT_LENGTH]: OVERSIZE_CONTENT_LENGTH },
      }),
    );
    expect(oldCap.status).toBe(413);
    expect(newCap.status).toBe(oldCap.status);
    expect(oldCap.headers.connection).toBe('close');
    expect(newCap.headers.connection).toBe('close');
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('the card no-auth 401 is identical old-vs-new (completes the masked /api/card re-pin)', async () => {
    // The card 413 re-pin above covers the pre-auth short-circuit, but adding /api/card to the
    // rateLimitedBodyToCode deviation masks EVERY /api/card divergence in the aggregate filter.
    // A normal-size card POST with no bearer passes cardContentLengthGuard and 401s at
    // activeGuard (the same shared guard as the wallet routes), byte-identical on both paths.
    // This dedicated assertion re-pins that 401 so the masking cannot hide an auth-shape break.
    const { oldCap, newCap } = await captureBothModes(() =>
      makeReq({ method: 'POST', url: '/api/card' }),
    );
    expect(oldCap.status).toBe(401);
    expect(newCap.status).toBe(oldCap.status);
    expect(stableStringify(newCap)).toBe(stableStringify(oldCap));
  });

  it('CORS + OPTIONS preflight is byte-identical old-vs-new for an /api route and a public-cors path', async () => {
    // Representative /api route: maybeCors reflects the Origin, the 204 short-circuit
    // returns before the ladder.
    const apiPreflight = await captureBothModes(() =>
      makeReq({
        method: 'OPTIONS',
        url: REPRESENTATIVE_API_PATH,
        headers: { origin: REFLECTED_ORIGIN, 'access-control-request-method': 'GET' },
      }),
    );
    expect(apiPreflight.oldCap.status).toBe(204);
    expect(stableStringify(apiPreflight.newCap)).toBe(stableStringify(apiPreflight.oldCap));
    expect(apiPreflight.oldCap.headers['access-control-allow-origin']).toBe(REFLECTED_ORIGIN);
    expect(apiPreflight.oldCap.headers['access-control-allow-methods']).toBe(
      'GET, POST, DELETE, OPTIONS',
    );
    expect(apiPreflight.oldCap.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type',
    );
    expect(apiPreflight.oldCap.headers.vary).toBe('Origin');

    // Public-cors path: the wide-open '*' set, the 204 short-circuit.
    const publicPreflight = await captureBothModes(() =>
      makeReq({
        method: 'OPTIONS',
        url: PUBLIC_CORS_PATH,
        headers: { origin: REFLECTED_ORIGIN, 'access-control-request-method': 'GET' },
      }),
    );
    expect(publicPreflight.oldCap.status).toBe(204);
    expect(stableStringify(publicPreflight.newCap)).toBe(stableStringify(publicPreflight.oldCap));
    expect(publicPreflight.oldCap.headers['access-control-allow-origin']).toBe('*');
    expect(publicPreflight.oldCap.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(publicPreflight.oldCap.headers.vary).toBe('Origin');
  });
});

// -----------------------------------------------------------------------------
// SKIPPED requests (present in characterization.test.ts or on the surface, but not
// replayed here) and why:
//   - GET /api/project-stats, GET /api/arena/leaderboard, GET /api/woc/balance,
//     GET /api/email/unsubscribe?token=<non-empty>, GET /api/search WITH a bearer,
//     and every populated leaderboard/character/account success body: all reach
//     pool.query against the pool-less test db (hang or pool-500), so they are not
//     db-free contract paths. Deferred exactly as characterization defers them.
//   - GET /api/auth/discord/callback SUCCESS bounce: embeds a live session token in
//     inlined HTML the normalizer returns verbatim (non-deterministic + a privacy
//     flag); only the error bounce is replayed.
//   - The /admin/api/*, /oauth/*, and /internal/* surfaces: those route through
//     handleAdminApi / handleOAuth / handleInternalApi, NOT the flag-gated /api
//     dispatcher (apiEntry), so they are out of scope for the /api parity anchor.
// -----------------------------------------------------------------------------
