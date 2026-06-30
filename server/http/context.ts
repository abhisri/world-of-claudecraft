// The request-context builder plus the reqId AsyncLocalStorage carrier for the
// API pipeline (Phase 5 of docs/api-pipeline/).
//
// buildContext turns a (req, res, MatchResult) triple into the frozen Ctx
// (server/http/types.ts) that handlers and middleware read instead of touching
// req/res directly. Per the frozen contract, body and account stay undefined
// here: Phase 8's withBody/auth middleware fill them. Client IP is REUSED from
// ratelimit.requestIp (X-Forwarded-For aware), never re-derived from the socket.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { requestIp } from '../ratelimit';
import type { MatchResult } from './router';
import type { Ctx, Method, RouteDef } from './types';

// node:http req.url is origin-form (path + query) and carries no scheme/host, so
// `new URL` needs a base. This placeholder authority lets us parse it; only
// pathname/search are load-bearing this phase (it matches the Phase 2 fakeCtx base).
const PLACEHOLDER_ORIGIN = 'http://localhost';
// Fallback request target when req.url is absent or unparseable. The leading slash
// keeps it a valid origin-form path that resolves against PLACEHOLDER_ORIGIN.
const DEFAULT_REQUEST_PATH = '/';
// Fallback method when req.method is absent. node delivers a method on every real
// request; this only guards the type so ctx.method is never undefined.
const DEFAULT_METHOD = 'GET';

// Per-request id carrier. It lets db.ts and other domain code read currentReqId()
// for logging/correlation WITHOUT threading ctx through every call; runOnion (the
// Phase 5 compose.ts) wraps the composed run in runWithReqId so the same id spans
// every await on the request.
export const reqIdStorage = new AsyncLocalStorage<string>();

/** Mint a fresh, unique per-request id (a server-side id, not sim randomness). */
export function newReqId(): string {
  return randomUUID();
}

/** Run `fn` with `reqId` bound as the ambient request id for the duration. */
export function runWithReqId<T>(reqId: string, fn: () => T): T {
  return reqIdStorage.run(reqId, fn);
}

/** The ambient request id, or undefined when called outside any runWithReqId. */
export function currentReqId(): string | undefined {
  return reqIdStorage.getStore();
}

/**
 * Parse a URL's query string into the Ctx.query shape: a key seen once is a
 * string, a key seen two or more times is the ordered string[] of its values.
 * Built on a null-prototype object (defense-in-depth against a prototype-polluted
 * query key, matching the router's null-proto params idiom).
 */
function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = Object.create(null);
  // searchParams.keys() repeats a key once per value, so dedupe before getAll.
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  return query;
}

/**
 * Parse req.url into a WHATWG URL whose authority is ALWAYS the fixed placeholder.
 * req.url is normally origin-form (/path?query) but a client may send absolute-form
 * (GET http://host/path), where `new URL(input, base)` ignores the base and adopts
 * the client's host. We rebuild from path + search ONLY, so a client can never inject
 * a foreign authority into ctx.url (which a later phase might trust for a redirect
 * Location or a same-origin check). It never throws: a target `new URL` cannot parse
 * falls back to the default path, keeping buildContext total (it runs before
 * runOnion's safety net once Phase 9 wires the dispatcher).
 */
function buildUrl(target: string): URL {
  try {
    const parsed = new URL(target, PLACEHOLDER_ORIGIN);
    return new URL(parsed.pathname + parsed.search, PLACEHOLDER_ORIGIN);
  } catch {
    return new URL(DEFAULT_REQUEST_PATH, PLACEHOLDER_ORIGIN);
  }
}

/**
 * Build the frozen Ctx for one request. Reads ONLY params from the match (the
 * matched variant alone carries them); body and account stay undefined until
 * Phase 8.
 */
export function buildContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: MatchResult<RouteDef>,
): Ctx {
  const url = buildUrl(req.url ?? DEFAULT_REQUEST_PATH);
  // The router validates the request method before Phase 9 calls buildContext (and
  // node delivers it uppercase already), so here we only normalize the case and trust it.
  const method = (req.method ?? DEFAULT_METHOD).toUpperCase() as Method;
  // The matched variant alone carries params; every other variant gets a FRESH,
  // empty null-proto object (never a shared singleton a later caller could mutate).
  const params =
    match.kind === 'matched' ? match.params : (Object.create(null) as Record<string, string>);
  return {
    req,
    res,
    method,
    url,
    path: url.pathname,
    query: parseQuery(url.searchParams),
    params,
    ip: requestIp(req),
    reqId: newReqId(),
    body: undefined,
    account: undefined,
    state: new Map<string, unknown>(),
  };
}
