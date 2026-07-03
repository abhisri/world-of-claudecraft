// Drain-aware liveness/readiness plus the /metrics exposition handlers for the
// API pipeline (Phase 23 of docs/api-pipeline/).
//
// Liveness (/livez) answers 200 as long as the process runs; readiness (/readyz)
// answers 200 until shutdown calls markDraining(), then 503 so a load balancer or
// orchestrator stops routing NEW traffic while in-flight work drains. /metrics
// serves the Prometheus exposition text from the injected exporter.
//
// These are OPERATIONAL, dev-channel responses: plain English bodies, never a t()
// key and never the problem+json envelope (they are scraped by machines and read
// by operators, not shown to a player). Every response is Cache-Control: no-store
// so a proxy never serves a stale readiness state or a cached metrics snapshot.
//
// The readiness flag is a module-level singleton: the process has exactly one
// drain state. markDraining() is idempotent and one-way for the process lifetime;
// resetHealthForTests() restores the initial state so a test file stays isolated.

import type * as http from 'node:http';
import { logger } from './logger';

/** The Cache-Control every health/metrics response carries: never cache operational state. */
export const HEALTH_CACHE_CONTROL = 'no-store';

/** true once markDraining() flips it; the process starts ready (not draining). */
let draining = false;

/**
 * Flip the process into draining: /readyz starts answering 503 so new traffic is
 * shed while in-flight requests finish. Idempotent (repeat calls are a no-op) and
 * one-way for the process lifetime; shutdown calls it first.
 */
export function markDraining(): void {
  draining = true;
}

/** Readiness: true until markDraining(); false once the process is draining. */
export function isReady(): boolean {
  return !draining;
}

/** Liveness: true for the whole process lifetime (the process running IS liveness). */
export function isLive(): boolean {
  return true;
}

/** Test-only: restore the initial (not-draining) state so a test file stays isolated. */
export function resetHealthForTests(): void {
  draining = false;
}

/** Write a plain-text operational response with the no-store header. */
function writePlain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': HEALTH_CACHE_CONTROL,
  });
  res.end(body);
}

/** GET /livez: 200 'ok' as long as the process runs (it answers even while draining). */
export function handleLivez(res: http.ServerResponse): void {
  writePlain(res, 200, 'ok');
}

/** GET /readyz: 200 'ok' while ready, 503 'draining' once markDraining() has fired. */
export function handleReadyz(res: http.ServerResponse): void {
  if (isReady()) writePlain(res, 200, 'ok');
  else writePlain(res, 503, 'draining');
}

/** What handleMetrics needs from the exporter: the exposition text and its content type. */
export interface MetricsSource {
  metricsText(): Promise<string>;
  contentType: string;
}

/**
 * GET /metrics: serve the Prometheus exposition text with the exporter's content
 * type. metricsText() is awaited BEFORE the head is written, so an exposition
 * failure never propagates into the request path and never leaves a half-written
 * response: it is logged and answered 500 text/plain. Cache-Control: no-store on
 * both arms so a scrape is never served a cached snapshot.
 */
export async function handleMetrics(res: http.ServerResponse, deps: MetricsSource): Promise<void> {
  try {
    const text = await deps.metricsText();
    res.writeHead(200, {
      'Content-Type': deps.contentType,
      'Cache-Control': HEALTH_CACHE_CONTROL,
    });
    res.end(text);
  } catch (err) {
    logger.error({ err }, 'metrics exposition failed');
    writePlain(res, 500, 'metrics unavailable');
  }
}
