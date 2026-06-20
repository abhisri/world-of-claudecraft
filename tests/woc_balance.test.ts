import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  WOC_BALANCE_CACHE_MAX_ENTRIES,
  fetchWocBalance,
  holderInfoForPubkey,
  cachedWocBalance,
  handleWocBalance,
  resetWocBalanceCacheForTests,
  wocBalanceCacheStats,
} from '../server/woc_balance';

// A real 32-byte base58 Solana address (passes isSolanaAddress).
const VALID_ADDR = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

function makeRes(): any {
  return {
    statusCode: 0, body: '',
    writeHead(s: number) { this.statusCode = s; return this; },
    end(d: string) { this.body = d ?? ''; return this; },
  };
}
const callBalance = async (owner: string) => {
  const res = makeRes();
  await handleWocBalance(res, owner);
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : {} };
};

// holderInfoForPubkey returns { tier, balance }; these cases assert the tier.
const holderTierForPubkey = async (pubkey: string) => (await holderInfoForPubkey(pubkey)).tier;

// Mock the Solana JSON-RPC: return token accounts whose uiAmounts we control.
function mockRpc(uiAmounts: number[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: { value: uiAmounts.map((ui) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmount: ui } } } } } })) },
    }),
  }));
}

type MockTokenAmount = {
  uiAmount?: unknown;
  uiAmountString?: unknown;
  amount?: unknown;
  decimals?: unknown;
};

function mockTokenAmountRpc(tokenAmounts: MockTokenAmount[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        value: tokenAmounts.map((tokenAmount) => ({
          account: { data: { parsed: { info: { tokenAmount } } } },
        })),
      },
    }),
  }));
}

// Mock the RPC with an arbitrary, possibly-malformed, parsed JSON body. Used to
// drive the defensive parsing paths in fetchWocBalance (missing/typeless fields).
function mockRawRpc(body: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => body }));
}

afterEach(() => {
  resetWocBalanceCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('server import boundary', () => {
  it('keeps holder tier math out of src/ui imports', () => {
    const source = readFileSync(new URL('../server/woc_balance.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/src\/ui\/holder_tier|ui\/holder_tier/);
    expect(source).toContain('../src/sim/holder_tier');
  });
});

describe('fetchWocBalance', () => {
  it('sums uiAmount across all of the owner’s token accounts', async () => {
    vi.stubGlobal('fetch', mockRpc([1000, 250.5]));
    expect(await fetchWocBalance('AAA')).toBe(1250.5);
  });

  it('uses uiAmountString when uiAmount is null', async () => {
    vi.stubGlobal('fetch', mockTokenAmountRpc([
      { uiAmount: null, uiAmountString: '1000.25' },
      { uiAmount: null, uiAmountString: '0.75' },
    ]));
    expect(await fetchWocBalance('AA2')).toBe(1001);
  });

  it('uses raw amount and decimals when uiAmount is null and uiAmountString is unavailable', async () => {
    vi.stubGlobal('fetch', mockTokenAmountRpc([
      { uiAmount: null, amount: '123456789', decimals: 6 },
      { uiAmount: null, amount: '1000000000000000000', decimals: 9 },
    ]));
    expect(await fetchWocBalance('AA3')).toBeCloseTo(1_000_000_123.456789, 6);
  });

  it('falls back from an invalid uiAmountString to raw amount and decimals', async () => {
    vi.stubGlobal('fetch', mockTokenAmountRpc([
      { uiAmount: null, uiAmountString: 'not-a-number', amount: '2500000', decimals: 6 },
    ]));
    expect(await fetchWocBalance('AA4')).toBe(2.5);
  });

  it('returns null on a non-ok RPC response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchWocBalance('BBB')).toBeNull();
  });

  it('returns null when the RPC throws (no token accounts / network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchWocBalance('CCC')).toBeNull();
  });

  it('returns 0 for an owner with no token accounts (empty value array)', async () => {
    vi.stubGlobal('fetch', mockRpc([]));
    expect(await fetchWocBalance('DDD')).toBe(0);
  });

  it('returns null when result.value is not an array', async () => {
    vi.stubGlobal('fetch', mockRawRpc({ result: { value: 'not-an-array' } }));
    expect(await fetchWocBalance('EEE')).toBeNull();
  });

  it('returns null when result.value is missing entirely', async () => {
    vi.stubGlobal('fetch', mockRawRpc({ result: {} }));
    expect(await fetchWocBalance('FFF')).toBeNull();
  });

  it('skips a token account missing tokenAmount/uiAmount (summed as 0)', async () => {
    vi.stubGlobal('fetch', mockRawRpc({
      result: {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 42 } } } } } },
          { account: { data: { parsed: { info: {} } } } }, // no tokenAmount → skipped
          {}, // no account at all → skipped
        ],
      },
    }));
    expect(await fetchWocBalance('GGG')).toBe(42);
  });

  it('skips malformed token amount fields, summing only parseable balances', async () => {
    vi.stubGlobal('fetch', mockRawRpc({
      result: {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: '500' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: null } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '1e9' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '2500000.5', decimals: 6 } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 7.5 } } } } } },
        ],
      },
    }));
    expect(await fetchWocBalance('HHH')).toBe(7.5);
  });
});

describe('holderTierForPubkey', () => {
  it('maps the on-chain balance to a tier index', async () => {
    vi.stubGlobal('fetch', mockRpc([10_000])); // Gilded
    expect(await holderTierForPubkey('tierGilded')).toBe(5);
  });

  it('caches within the TTL (one RPC per wallet)', async () => {
    const f = mockRpc([1_000_000]); // Whale
    vi.stubGlobal('fetch', f);
    expect(await holderTierForPubkey('tierWhale')).toBe(7);
    expect(await holderTierForPubkey('tierWhale')).toBe(7);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns 0 for a never-seen wallet when the RPC fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await holderTierForPubkey('tierUnseen')).toBe(0);
  });

  it('returns 0 (no tier) for a wallet holding under 1 $WOC', async () => {
    vi.stubGlobal('fetch', mockRpc([0]));
    expect(await holderTierForPubkey('tierBroke')).toBe(0);
  });

  it('re-fetches after the cache TTL expires (fake-clock advance)', async () => {
    vi.useFakeTimers();
    const first = mockRpc([10_000]); // Gilded (tier 5)
    vi.stubGlobal('fetch', first);
    expect(await holderTierForPubkey('tierExpiry')).toBe(5); // 1st RPC
    expect(await holderTierForPubkey('tierExpiry')).toBe(5); // cached, no new RPC
    expect(first).toHaveBeenCalledTimes(1);

    // Past the 5-minute TTL the cache entry is stale → next call re-fetches.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    const second = mockRpc([100_000]); // Vaultwarden (tier 6), a different balance
    vi.stubGlobal('fetch', second);
    expect(await holderTierForPubkey('tierExpiry')).toBe(6); // re-fetched the new tier
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known tier when a refresh fails for a known wallet', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockRpc([10_000])); // Gilded (tier 5)
    expect(await holderTierForPubkey('tierKeepLast')).toBe(5); // prime the cache

    // After the TTL the entry is stale, so the next call must re-fetch, but the
    // RPC now fails, so it keeps the last known tier rather than dropping to 0.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await holderTierForPubkey('tierKeepLast')).toBe(5);
  });

  it('maps a balance exactly at a tier threshold to that tier (1000 → Silverbound tier 4)', async () => {
    vi.stubGlobal('fetch', mockRpc([1_000])); // exactly Silverbound's threshold
    expect(await holderTierForPubkey('tierThresholdEdge')).toBe(4);
  });
});

describe('holderInfoForPubkey (tier + exact balance)', () => {
  it('returns both the tier and the exact summed balance', async () => {
    vi.stubGlobal('fetch', mockRpc([10_000])); // Gilded (tier 5)
    expect(await holderInfoForPubkey('infoGilded')).toEqual({ tier: 5, balance: 10_000 });
  });

  it('returns the summed balance across multiple token accounts with its tier', async () => {
    // 1000 + 250.5 = 1250.5 → still Silverbound (tier 4, threshold 1000).
    vi.stubGlobal('fetch', mockRpc([1_000, 250.5]));
    expect(await holderInfoForPubkey('infoSum')).toEqual({ tier: 4, balance: 1_250.5 });
  });

  it('returns {tier:0, balance:0} for a balance under 1 $WOC', async () => {
    vi.stubGlobal('fetch', mockRpc([0.5]));
    expect(await holderInfoForPubkey('infoSubEmber')).toEqual({ tier: 0, balance: 0.5 });
  });

  it('returns {tier:0, balance:0} for a never-seen wallet when the RPC fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await holderInfoForPubkey('infoUnseen')).toEqual({ tier: 0, balance: 0 });
  });

  it('keeps the last known BALANCE and tier when a refresh fails for a known wallet', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockRpc([12_345])); // Gilded (tier 5), exact balance 12345
    expect(await holderInfoForPubkey('infoKeepLast')).toEqual({ tier: 5, balance: 12_345 });

    // Past the TTL the cache is stale, so the next call re-fetches, but the RPC
    // now fails, so it must keep the last known {tier, balance}, not drop to 0.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await holderInfoForPubkey('infoKeepLast')).toEqual({ tier: 5, balance: 12_345 });
  });
});

describe('cachedWocBalance', () => {
  it('returns the freshly fetched balance', async () => {
    vi.stubGlobal('fetch', mockRpc([10_000]));
    expect(await cachedWocBalance('cacheFresh')).toBe(10_000);
  });

  it('serves the cached balance within the TTL (one RPC per wallet)', async () => {
    const f = mockRpc([2_500]);
    vi.stubGlobal('fetch', f);
    expect(await cachedWocBalance('cacheHit')).toBe(2_500);
    expect(await cachedWocBalance('cacheHit')).toBe(2_500);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tracks cache hits, misses, stores and current cache size', async () => {
    const f = mockRpc([2_500]);
    vi.stubGlobal('fetch', f);
    expect(await cachedWocBalance('cacheStats')).toBe(2_500);
    expect(await cachedWocBalance('cacheStats')).toBe(2_500);

    expect(wocBalanceCacheStats()).toEqual(expect.objectContaining({
      entries: 1,
      maxEntries: WOC_BALANCE_CACHE_MAX_ENTRIES,
      hits: 1,
      misses: 1,
      stores: 1,
      failures: 0,
    }));
  });

  it('keeps the last known balance when a refresh fails after the TTL', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockRpc([777]));
    expect(await cachedWocBalance('cacheKeep')).toBe(777);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await cachedWocBalance('cacheKeep')).toBe(777); // last known, not null
  });

  it('returns null for a never-seen wallet when the RPC fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    expect(await cachedWocBalance('cacheUnseen')).toBeNull();
  });

  it('evicts the oldest cached balance when successful unique wallets exceed the cap', async () => {
    const f = mockRpc([1]);
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < WOC_BALANCE_CACHE_MAX_ENTRIES; i++) {
      expect(await cachedWocBalance(`cacheBounded${i}`)).toBe(1);
    }
    expect(f).toHaveBeenCalledTimes(WOC_BALANCE_CACHE_MAX_ENTRIES);

    expect(await cachedWocBalance('cacheBounded0')).toBe(1);
    expect(f).toHaveBeenCalledTimes(WOC_BALANCE_CACHE_MAX_ENTRIES);

    expect(await cachedWocBalance(`cacheBounded${WOC_BALANCE_CACHE_MAX_ENTRIES}`)).toBe(1);
    expect(f).toHaveBeenCalledTimes(WOC_BALANCE_CACHE_MAX_ENTRIES + 1);

    expect(await cachedWocBalance('cacheBounded1')).toBe(1);
    expect(f).toHaveBeenCalledTimes(WOC_BALANCE_CACHE_MAX_ENTRIES + 2);
  });
});

describe('handleWocBalance (GET /api/woc/balance proxy)', () => {
  it('rejects an invalid Solana address with 400 and never hits the RPC', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { status, data } = await callBalance('not-a-real-address');
    expect(status).toBe(400);
    expect(data.error).toMatch(/invalid Solana/i);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects an empty owner with 400', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await callBalance('')).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('returns 200 with the exact balance for a valid address', async () => {
    vi.stubGlobal('fetch', mockRpc([1_000, 234.5]));
    const { status, data } = await callBalance(VALID_ADDR);
    expect(status).toBe(200);
    expect(data).toEqual({ balance: 1_234.5 });
  });

  it('returns 200 with balance:null when the RPC fails for an unseen wallet (UI omits it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    const other = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 40));
    const { status, data } = await callBalance(other);
    expect(status).toBe(200);
    expect(data).toEqual({ balance: null });
  });
});
