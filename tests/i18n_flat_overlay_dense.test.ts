// TEMPORARY (Phase 3 + Phase 4). The 13 non-English locales are flat dotted-key
// overlays (src/ui/i18n.locales/<lang>.ts, `Record<string, string>`). Two shapes:
//
//  - The 10 locales overlaid DIRECTLY onto `en` (no declared base) stay DENSE this
//    phase: every overlay carries exactly the leaf set of the authoritative nested
//    `en`, with non-empty string values.
//  - The 3 DIALECT overlays (es_ES, fr_CA, en_CA) became DIVERGENCE-ONLY in Phase 4:
//    each declares a base locale (es_ES->es, fr_CA->fr_FR, en_CA->en) and carries
//    ONLY the keys whose value differs from that base. So a dialect overlay must be a
//    SUBSET of `en`'s leaves, all string values, and - the dedup invariant - every
//    key must actually differ from the base value (no key kept equal to the base).
//
// That is the type guarantee tsc cannot give here - `Record<TranslationKey, string>`
// can't type the overlays because `TranslationKey = Leaves<typeof en, 5>` stops at
// depth 5 while the deepest real leaves (entities.quests.<id>.objectives.0.label) are
// 6 segments deep - so a test enforces it instead (the phase invariant: a typo'd or
// redundant dotted key must fail tsc OR a test). Phase 6 relaxes the dense overlays to
// sparse and this whole check is replaced by the registry-driven coverage gate; delete
// it then.

import { describe, expect, it } from 'vitest';
import { en } from '../src/ui/i18n.en';
import { es } from '../src/ui/i18n.locales/es';
import { es_ES } from '../src/ui/i18n.locales/es_ES';
import { fr_FR } from '../src/ui/i18n.locales/fr_FR';
import { fr_CA } from '../src/ui/i18n.locales/fr_CA';
import { en_CA } from '../src/ui/i18n.locales/en_CA';
import { it_IT } from '../src/ui/i18n.locales/it_IT';
import { de_DE } from '../src/ui/i18n.locales/de_DE';
import { zh_CN } from '../src/ui/i18n.locales/zh_CN';
import { zh_TW } from '../src/ui/i18n.locales/zh_TW';
import { ko_KR } from '../src/ui/i18n.locales/ko_KR';
import { ja_JP } from '../src/ui/i18n.locales/ja_JP';
import { pt_BR } from '../src/ui/i18n.locales/pt_BR';
import { ru_RU } from '../src/ui/i18n.locales/ru_RU';

// Recurse into plain objects only (arrays/non-objects are leaves) - the same
// object-vs-leaf rule scripts/i18n_flatten.mjs and the build's deepMerge use.
function flatten(node: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const key of Object.keys(node as Record<string, unknown>)) {
    const value = (node as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

const enFlat = flatten(en) as Record<string, string>;
const enKeys = Object.keys(enFlat).sort();
const enKeySet = new Set(enKeys);

// Locales overlaid directly onto `en` (no declared base): DENSE this phase.
const denseOverlays: Record<string, Record<string, string>> = {
  es, fr_FR, it_IT, de_DE, zh_CN, zh_TW, ko_KR, ja_JP, pt_BR, ru_RU,
};

// Dialect overlays: divergence-only over a declared base (Phase 4). `base` is the
// effective flat base value-map (the dense base overlay, or flatten(en) for en_CA).
const dialectOverlays: { lang: string; overlay: Record<string, string>; base: Record<string, string> }[] = [
  { lang: 'es_ES', overlay: es_ES, base: es },
  { lang: 'fr_CA', overlay: fr_CA, base: fr_FR },
  { lang: 'en_CA', overlay: en_CA, base: enFlat },
];

describe('flat locale overlays: dense bases + divergence-only dialects', () => {
  it('en has a non-trivial leaf set', () => {
    expect(enKeys.length).toBeGreaterThan(1000);
  });

  for (const [lang, overlay] of Object.entries(denseOverlays)) {
    it(`${lang}: key set exactly equals en's leaf set (dense, no typo'd/extra keys)`, () => {
      expect(Object.keys(overlay).sort()).toEqual(enKeys);
    });

    it(`${lang}: every value is a non-empty string`, () => {
      const bad = Object.entries(overlay).filter(([, v]) => typeof v !== 'string' || v.length === 0);
      expect(bad.map(([k]) => k)).toEqual([]);
    });
  }

  for (const { lang, overlay, base } of dialectOverlays) {
    it(`${lang}: every key is a real en leaf (subset)`, () => {
      const notLeaf = Object.keys(overlay).filter((k) => !enKeySet.has(k)).sort();
      expect(notLeaf).toEqual([]);
    });

    it(`${lang}: every value is a non-empty string`, () => {
      const bad = Object.entries(overlay).filter(([, v]) => typeof v !== 'string' || v.length === 0);
      expect(bad.map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: every key genuinely diverges from its base (no redundant duplication)`, () => {
      const redundant = Object.keys(overlay).filter((k) => overlay[k] === base[k]).sort();
      expect(redundant).toEqual([]);
    });

    it(`${lang}: is strictly sparser than a dense overlay (dedup actually happened)`, () => {
      expect(Object.keys(overlay).length).toBeGreaterThan(0);
      expect(Object.keys(overlay).length).toBeLessThan(enKeys.length);
    });
  }
});
