import { describe, expect, it } from 'vitest';
import type { ItemDef } from '../src/sim/types';
import { itemArmorTypeLabelKey } from '../src/ui/item_armor_type';

function armor(extra: Partial<ItemDef>): ItemDef {
  return {
    id: 'test',
    name: 'Test',
    kind: 'armor',
    slot: 'chest',
    sellValue: 1,
    ...extra,
  };
}

describe('itemArmorTypeLabelKey', () => {
  it('uses the explicit armorType field when present', () => {
    expect(itemArmorTypeLabelKey(armor({ armorType: 'cloth' }))).toBe(
      'hudChrome.itemArmorType.cloth',
    );
    expect(itemArmorTypeLabelKey(armor({ armorType: 'leather' }))).toBe(
      'hudChrome.itemArmorType.leather',
    );
    expect(itemArmorTypeLabelKey(armor({ armorType: 'mail' }))).toBe(
      'hudChrome.itemArmorType.mail',
    );
  });

  it('infers the armor type from requiredClass', () => {
    expect(itemArmorTypeLabelKey(armor({ requiredClass: ['warrior', 'paladin'] }))).toBe(
      'hudChrome.itemArmorType.mail',
    );
    expect(itemArmorTypeLabelKey(armor({ requiredClass: ['rogue', 'hunter'] }))).toBe(
      'hudChrome.itemArmorType.leather',
    );
    expect(itemArmorTypeLabelKey(armor({ requiredClass: ['mage', 'priest', 'warlock'] }))).toBe(
      'hudChrome.itemArmorType.cloth',
    );
    // caster archetype (includes druid) infers cloth
    expect(itemArmorTypeLabelKey(armor({ requiredClass: ['mage', 'druid'] }))).toBe(
      'hudChrome.itemArmorType.cloth',
    );
  });

  it('returns null when there is no resolvable armor type', () => {
    // generic armor with no class hint
    expect(itemArmorTypeLabelKey(armor({}))).toBeNull();
    // weapons are never armor-typed here
    expect(
      itemArmorTypeLabelKey({
        id: 'sword',
        name: 'Sword',
        kind: 'weapon',
        slot: 'mainhand',
        sellValue: 1,
        requiredClass: ['warrior'],
      }),
    ).toBeNull();
  });

  it('returns null for armor whose required classes span different armor types', () => {
    // warrior (mail) + druid (leather/caster-cloth) is no single armor type
    expect(itemArmorTypeLabelKey(armor({ requiredClass: ['warrior', 'druid'] }))).toBeNull();
    // an empty class list is not a subset of any group
    expect(itemArmorTypeLabelKey(armor({ requiredClass: [] }))).toBeNull();
  });

  it('is deterministic for a given item', () => {
    const item = armor({ requiredClass: ['shaman'] });
    expect(itemArmorTypeLabelKey(item)).toBe(itemArmorTypeLabelKey(item));
  });
});
