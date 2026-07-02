// Unit test for the tier-2 pg-backed rate-limit store (server/ratelimit_db.ts).
// Postgres is injected as a fake pool (a query spy over a stubbed RETURNING row)
// and the clock is an injected fake, so every path is deterministic with no live
// database and no real timers. WINDOW_MS is imported from server/ratelimit as the
// single source of truth (no magic 60000).
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { MetricEvent, MetricSink } from '../../server/http/middleware/metric_sink';
import { WINDOW_MS } from '../../server/ratelimit';
import { createPgRateLimitStore, RATE_LIMIT_UPSERT_SQL } from '../../server/ratelimit_db';

// A fake clock: returns the current `t`, settable by the test.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (next: number) => {
      t = next;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// A fake pool whose query resolves the given RETURNING row. The spy records the
// (sql, params) of every call so tests assert the exact statement and params. The
// returned row is mutable so a test can pin what the UPSERT "returns" next.
function fakePool(returnRow: { count: number | string; window_start: number | string }) {
  const row = { ...returnRow };
  const query = vi.fn((_sql: string, _params?: unknown[]) => Promise.resolve({ rows: [row] }));
  return {
    query,
    setRow(next: { count: number | string; window_start: number | string }) {
      row.count = next.count;
      row.window_start = next.window_start;
    },
    // Cast through unknown: the store only ever calls pool.query.
    asPool: { query } as unknown as Pool,
  };
}

// A MetricSink spy that records every event it receives.
function fakeMetricSink(): MetricSink & { events: MetricEvent[] } {
  const events: MetricEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
  };
}

describe('createPgRateLimitStore hit()', () => {
  it('issues the exact parameterized UPSERT, splitting the policy at the first colon', async () => {
    const clock = fakeClock(90_000); // windowStart = 90000 - (90000 % 60000) = 60000
    const pool = fakePool({ count: 1, window_start: 60_000 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    await store.hit('login:1.2.3.4', 5);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(RATE_LIMIT_UPSERT_SQL, ['login', '1.2.3.4', 60_000]);
  });

  it('preserves an IPv6-containing class key intact after the first colon', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 1, window_start: 0 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    await store.hit('login:2001:db8::1', 5);

    // Only the FIRST colon splits: policy 'login', key the whole IPv6 literal.
    expect(pool.query).toHaveBeenCalledWith(RATE_LIMIT_UPSERT_SQL, ['login', '2001:db8::1', 0]);
  });

  it("falls back to policy 'default' for a key with no colon", async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 1, window_start: 0 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    await store.hit('globalflood', 5);

    expect(pool.query).toHaveBeenCalledWith(RATE_LIMIT_UPSERT_SQL, ['default', 'globalflood', 0]);
  });

  it('computes allowed / remaining / resetSeconds from the returned row at a pinned clock', async () => {
    const clock = fakeClock(90_000);
    // Stored window opened at 60000; it closes at 60000 + WINDOW_MS = 120000, so
    // 30s remain at now=90000. count 3 under a max of 5 is allowed with 2 left.
    const pool = fakePool({ count: 3, window_start: 60_000 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    const outcome = await store.hit('login:ip', 5);

    expect(outcome).toEqual({ allowed: true, remaining: 2, resetSeconds: 30 });
  });

  it('flips allowed to false at count = maxPerMinute + 1', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 5, window_start: 0 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    // count 5 with max 5: the last allowed hit (remaining 0).
    const atLimit = await store.hit('login:ip', 5);
    expect(atLimit).toEqual({ allowed: true, remaining: 0, resetSeconds: WINDOW_MS / 1000 });

    // count 6 with max 5: over the limit, still remaining 0 (clamped at 0).
    pool.setRow({ count: 6, window_start: 0 });
    const over = await store.hit('login:ip', 5);
    expect(over).toEqual({ allowed: false, remaining: 0, resetSeconds: WINDOW_MS / 1000 });
  });

  it('reports resetSeconds decreasing as the clock advances within one window', async () => {
    // A single stored window opened at 60000 (closes at 120000). The store reads
    // the returned window_start, so resetSeconds counts down toward the boundary.
    const pool = fakePool({ count: 1, window_start: 60_000 });

    const at = async (nowMs: number) => {
      const store = createPgRateLimitStore({ pool: pool.asPool, now: () => nowMs });
      return (await store.hit('login:ip', 5)).resetSeconds;
    };

    expect(await at(60_000)).toBe(60); // ceil((120000 - 60000) / 1000)
    expect(await at(90_000)).toBe(30);
    expect(await at(119_000)).toBe(1);
    expect(await at(120_000)).toBe(0); // boundary reached, never negative
  });

  it('reads count 1 for the new window once the returned window_start rolls forward', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 1, window_start: 0 });
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    // First hit at t=0 sits in the window that opened at 0.
    const first = await store.hit('login:ip', 5);
    expect(first).toEqual({ allowed: true, remaining: 4, resetSeconds: WINDOW_MS / 1000 });
    expect(pool.query).toHaveBeenLastCalledWith(RATE_LIMIT_UPSERT_SQL, ['login', 'ip', 0]);

    // Advance a full window. The UPSERT's CASE resets count to 1 for the new
    // window, which the store surfaces as a fresh window (params carry the new
    // window_start, and the returned row drives full remaining again).
    clock.set(WINDOW_MS);
    pool.setRow({ count: 1, window_start: WINDOW_MS });
    const rolled = await store.hit('login:ip', 5);
    expect(rolled).toEqual({ allowed: true, remaining: 4, resetSeconds: WINDOW_MS / 1000 });
    expect(pool.query).toHaveBeenLastCalledWith(RATE_LIMIT_UPSERT_SQL, ['login', 'ip', WINDOW_MS]);
  });

  it('increments the metric counter exactly once per hit', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 1, window_start: 0 });
    const metrics = fakeMetricSink();
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now, metrics });

    await store.hit('login:ip', 5);
    await store.hit('login:ip', 5);

    expect(metrics.events).toHaveLength(2);
    expect(metrics.events[0].route).toBe('ratelimit.pg.hit');
  });

  it('encodes the decision in the metric status (200 allowed, 429 limited)', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 5, window_start: 0 });
    const metrics = fakeMetricSink();
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now, metrics });

    await store.hit('login:ip', 5); // count 5, max 5: allowed
    pool.setRow({ count: 6, window_start: 0 });
    await store.hit('login:ip', 5); // count 6, max 5: limited

    expect(metrics.events[0].status).toBe(200);
    expect(metrics.events[1].status).toBe(429);
  });

  it('defaults to the no-op metric sink when none is supplied', async () => {
    const clock = fakeClock(0);
    const pool = fakePool({ count: 1, window_start: 0 });
    // No metrics option: must not throw and must still return a correct outcome.
    const store = createPgRateLimitStore({ pool: pool.asPool, now: clock.now });

    const outcome = await store.hit('login:ip', 5);
    expect(outcome).toEqual({ allowed: true, remaining: 4, resetSeconds: WINDOW_MS / 1000 });
  });
});

describe('createPgRateLimitStore reset()', () => {
  it('issues a DELETE against rate_limits', async () => {
    const pool = fakePool({ count: 1, window_start: 0 });
    const store = createPgRateLimitStore({ pool: pool.asPool });

    await store.reset();

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM rate_limits');
  });
});
