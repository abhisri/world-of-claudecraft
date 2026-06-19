import { describe, expect, it } from 'vitest';
import { characterAppearanceOptions } from '../src/ui/character_appearance';

describe('character appearance picker', () => {
  it('numbers unlocked mech cosmetics after the class appearances', () => {
    const options = characterAppearanceOptions('shaman', ['amber_crimson']);

    expect(options.map((option) => ({ kind: option.kind, label: option.label }))).toEqual([
      { kind: 'class', label: 1 },
      { kind: 'class', label: 2 },
      { kind: 'class', label: 3 },
      { kind: 'class', label: 4 },
      { kind: 'mech', label: 5 },
    ]);
    expect(options[4]).toMatchObject({
      kind: 'mech',
      skin: 0,
      chromaId: 'amber_crimson',
    });
  });
});
