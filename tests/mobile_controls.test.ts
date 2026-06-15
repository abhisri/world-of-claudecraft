import { describe, expect, it } from 'vitest';
import { clampJoystickOrigin, isPhoneTouchDevice, mapJoystickVector, mapLookVector } from '../src/game/mobile_controls';

describe('mapJoystickVector', () => {
  it('returns neutral inside the deadzone', () => {
    expect(mapJoystickVector(0, 0)).toEqual({ forward: false, back: false, strafeLeft: false, strafeRight: false });
    expect(mapJoystickVector(0.05, -0.08)).toEqual({ forward: false, back: false, strafeLeft: false, strafeRight: false });
  });

  it('maps cardinal movement directions', () => {
    expect(mapJoystickVector(0, -1)).toEqual({ forward: true, back: false, strafeLeft: false, strafeRight: false });
    expect(mapJoystickVector(0, 1)).toEqual({ forward: false, back: true, strafeLeft: false, strafeRight: false });
    expect(mapJoystickVector(-1, 0)).toEqual({ forward: false, back: false, strafeLeft: true, strafeRight: false });
    expect(mapJoystickVector(1, 0)).toEqual({ forward: false, back: false, strafeLeft: false, strafeRight: true });
  });

  it('maps diagonal movement directions', () => {
    expect(mapJoystickVector(0.7, -0.7)).toEqual({ forward: true, back: false, strafeLeft: false, strafeRight: true });
    expect(mapJoystickVector(-0.7, 0.7)).toEqual({ forward: false, back: true, strafeLeft: true, strafeRight: false });
  });
});

describe('isPhoneTouchDevice', () => {
  it('uses the phone touch media query', () => {
    const queries: string[] = [];
    const win = {
      matchMedia: (q: string) => {
        queries.push(q);
        return { matches: true };
      },
    } as unknown as Window;
    expect(isPhoneTouchDevice(win)).toBe(true);
    expect(queries[0]).toContain('pointer: coarse');
    expect(queries[0]).toContain('max-width: 940px');
    expect(queries[0]).toContain('max-height: 760px');
  });
});

describe('mapLookVector', () => {
  it('returns a neutral camera vector inside the deadzone', () => {
    expect(mapLookVector(0.02, 0.03)).toEqual({ x: 0, y: 0 });
  });

  it('keeps analog camera vector outside the deadzone', () => {
    const v = mapLookVector(0.45, -0.25);
    expect(v.x).toBeCloseTo(0.36);
    expect(v.y).toBeCloseTo(-0.2);
  });
});

describe('clampJoystickOrigin', () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 600 };
  const radius = 61;

  it('keeps an interior touch exactly where the thumb landed', () => {
    expect(clampJoystickOrigin(200, 300, radius, bounds)).toEqual({ x: 200, y: 300 });
  });

  it('pushes a corner touch inward so the whole circle stays on-screen', () => {
    expect(clampJoystickOrigin(5, 595, radius, bounds)).toEqual({ x: radius, y: bounds.bottom - radius });
  });

  it('clamps against the far edges too', () => {
    expect(clampJoystickOrigin(900, -50, radius, bounds)).toEqual({ x: bounds.right - radius, y: radius });
  });

  it('falls back to the axis midpoint when the zone is smaller than the joystick', () => {
    const tight = { left: 0, top: 0, right: 80, bottom: 600 };
    expect(clampJoystickOrigin(10, 300, radius, tight)).toEqual({ x: 40, y: 300 });
  });
});
