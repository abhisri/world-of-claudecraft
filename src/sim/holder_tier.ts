// Shared $WOC holder-tier thresholds.
//
// The simulation does not apply holder tiers as gameplay rules. This pure module
// exists so server code and presentation code can agree on the cosmetic tier
// index without importing across server/UI boundaries.

/** $WOC max supply (1,000,000,000). Percentages on the ladder are relative to this. */
export const WOC_MAX_SUPPLY = 1_000_000_000;

export interface HolderTierCore {
  /** 1-based rung (1 = Ember, 10 = Sovereign). */
  index: number;
  /** Stable machine key used for CSS hooks, analytics, and presentation lookup. */
  key: string;
  /** Minimum whole-$WOC balance to reach this rung. */
  threshold: number;
}

export const HOLDER_TIER_DEFS = [
  { index: 1, key: 'ember', threshold: 1 },
  { index: 2, key: 'coinbearer', threshold: 10 },
  { index: 3, key: 'coppercrest', threshold: 100 },
  { index: 4, key: 'silverbound', threshold: 1_000 },
  { index: 5, key: 'gilded', threshold: 10_000 },
  { index: 6, key: 'vaultwarden', threshold: 100_000 },
  { index: 7, key: 'whale', threshold: 1_000_000 },
  { index: 8, key: 'leviathan', threshold: 10_000_000 },
  { index: 9, key: 'worldbearer', threshold: 100_000_000 },
  { index: 10, key: 'sovereign', threshold: WOC_MAX_SUPPLY },
] as const satisfies readonly HolderTierCore[];

export type HolderTierKey = typeof HOLDER_TIER_DEFS[number]['key'];

/**
 * The highest rung a balance qualifies for, or null when there is no connected
 * wallet (balance === null) or the balance is below the first rung (< 1 $WOC).
 */
export function holderTierForBalance(balance: number | null): HolderTierCore | null {
  if (balance === null || !Number.isFinite(balance) || balance < HOLDER_TIER_DEFS[0].threshold) return null;
  let tier: HolderTierCore | null = null;
  for (const t of HOLDER_TIER_DEFS) {
    if (balance >= t.threshold) tier = t;
    else break;
  }
  return tier;
}

/** The 1-based rung index for a balance, or 0 when the balance qualifies for no rung. */
export function holderTierIndexForBalance(balance: number | null): number {
  return holderTierForBalance(balance)?.index ?? 0;
}

/** The rung at a 1-based index (1-10), or undefined for 0/out-of-range. */
export function holderTierByIndex(index: number): HolderTierCore | undefined {
  return Number.isInteger(index) && index >= 1 && index <= HOLDER_TIER_DEFS.length
    ? HOLDER_TIER_DEFS[index - 1]
    : undefined;
}

/** This rung's share of max supply, as a fraction in [0, 1]. */
export function tierSupplyShare(tier: Pick<HolderTierCore, 'threshold'>): number {
  return tier.threshold / WOC_MAX_SUPPLY;
}
