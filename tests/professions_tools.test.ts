import { describe, expect, it } from 'vitest';
import { ITEMS, NPCS } from '../src/sim/data';
import { canGatherTier, gatherToolTier, isGatherToolUse } from '../src/sim/professions/tools';

describe('gathering tool tier gating (#1123)', () => {
  it('a tier-1 tool cannot gather a tier-2 or higher node', () => {
    expect(canGatherTier(1, 1)).toBe(true);
    expect(canGatherTier(1, 2)).toBe(false);
    expect(canGatherTier(1, 3)).toBe(false);
  });

  it('a tier-2 tool can gather both tier-1 and tier-2 nodes, but not tier-3', () => {
    expect(canGatherTier(2, 1)).toBe(true);
    expect(canGatherTier(2, 2)).toBe(true);
    expect(canGatherTier(2, 3)).toBe(false);
  });

  it('a tier-3 tool can gather every tier at or below it', () => {
    expect(canGatherTier(3, 1)).toBe(true);
    expect(canGatherTier(3, 2)).toBe(true);
    expect(canGatherTier(3, 3)).toBe(true);
  });

  it('vendor-sold base tools exist for each gathering profession at 3 tiers', () => {
    const mining = [ITEMS.copper_mining_pick, ITEMS.iron_mining_pick, ITEMS.mithril_mining_pick];
    const logging = [ITEMS.handaxe, ITEMS.felling_axe, ITEMS.ironbark_axe];
    const herbalism = [ITEMS.gathering_sickle, ITEMS.bronze_sickle, ITEMS.silverleaf_sickle];
    for (const [profession, tools] of [
      ['mining', mining],
      ['logging', logging],
      ['herbalism', herbalism],
    ] as const) {
      expect(tools.every(Boolean)).toBe(true);
      const tiers = tools.map((item) => gatherToolTier(item, profession));
      expect(tiers).toEqual([1, 2, 3]);
    }
  });

  it('the base tools are actually stocked by Trader Wilkes', () => {
    const stock = NPCS.trader_wilkes.vendorItems ?? [];
    for (const toolId of [
      'copper_mining_pick',
      'iron_mining_pick',
      'mithril_mining_pick',
      'handaxe',
      'felling_axe',
      'ironbark_axe',
      'gathering_sickle',
      'bronze_sickle',
      'silverleaf_sickle',
    ]) {
      expect(stock).toContain(toolId);
    }
  });

  it('a base tool never becomes unusable, because this repo has no durability mechanic', () => {
    const pick = ITEMS.copper_mining_pick;
    // ItemDef (src/sim/types.ts) carries no durability field anywhere in this repo,
    // so simulating repeated gathers cannot reduce or exhaust a tool's usability:
    // there is nothing on the item shape a "gather" could decrement.
    expect(pick).not.toHaveProperty('durability');
    expect(isGatherToolUse(pick.use)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      // Repeated simulated gathers: the item object is never mutated.
      expect(gatherToolTier(pick, 'mining')).toBe(1);
    }
    expect(pick).not.toHaveProperty('durability');
  });

  it('gatherToolTier returns undefined for a non-tool item and for a mismatched profession', () => {
    expect(gatherToolTier(ITEMS.worn_sword, 'mining')).toBeUndefined();
    expect(gatherToolTier(ITEMS.copper_mining_pick, 'logging')).toBeUndefined();
  });
});
