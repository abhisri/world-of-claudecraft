import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultIconPrewarmEntries,
  type IconPrewarmEntry,
  prewarmIconCache,
} from '../src/ui/icon_prewarm';

type IdleCb = (d: { timeRemaining(): number }) => void;

// Minimal window stub: captures idle callbacks so the test drives the pump by
// hand (the vitest env is plain Node; jsdom is deliberately not a dependency).
function stubWindow(): { idleQueue: IdleCb[]; restore: () => void } {
  const idleQueue: IdleCb[] = [];
  const fake = {
    requestIdleCallback: (cb: IdleCb) => {
      idleQueue.push(cb);
      return idleQueue.length;
    },
    setTimeout: (cb: () => void) => {
      idleQueue.push(() => cb());
      return 0;
    },
  };
  const prev = (globalThis as any).window;
  (globalThis as any).window = fake;
  return {
    idleQueue,
    restore: () => {
      if (prev === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prev;
    },
  };
}

function entries(n: number): IconPrewarmEntry[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'item' as const, id: `it${i}` }));
}

describe('prewarmIconCache', () => {
  let restore = () => {};
  afterEach(() => restore());

  it('warms every entry across slices and stops rescheduling when drained', () => {
    const w = stubWindow();
    restore = w.restore;
    const warmed: string[] = [];
    prewarmIconCache(entries(20), { warm: (_k, id) => warmed.push(id) });
    // no deadline (undefined) means one bounded slice per callback
    while (w.idleQueue.length > 0) w.idleQueue.shift()!(undefined as any);
    expect(warmed).toHaveLength(20);
    expect(warmed[0]).toBe('it0');
    expect(warmed[19]).toBe('it19');
    expect(w.idleQueue).toHaveLength(0); // drained: no further schedule
  });

  it('uses the idle deadline to run multiple slices in one callback', () => {
    const w = stubWindow();
    restore = w.restore;
    const warmed: string[] = [];
    prewarmIconCache(entries(30), { warm: (_k, id) => warmed.push(id) });
    w.idleQueue.shift()!({ timeRemaining: () => 50 }); // generous deadline drains all
    expect(warmed).toHaveLength(30);
  });

  it('cancel stops the pump between slices', () => {
    const w = stubWindow();
    restore = w.restore;
    const warmed: string[] = [];
    const cancel = prewarmIconCache(entries(20), { warm: (_k, id) => warmed.push(id) });
    w.idleQueue.shift()!(undefined as any); // first slice only
    const after = warmed.length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(20);
    cancel();
    while (w.idleQueue.length > 0) w.idleQueue.shift()!(undefined as any);
    expect(warmed).toHaveLength(after); // nothing warmed after cancel
  });

  it('a throwing recipe is skipped, not fatal', () => {
    const w = stubWindow();
    restore = w.restore;
    const warmed: string[] = [];
    prewarmIconCache(entries(3), {
      warm: (_k, id) => {
        if (id === 'it1') throw new Error('bad recipe');
        warmed.push(id);
      },
    });
    while (w.idleQueue.length > 0) w.idleQueue.shift()!(undefined as any);
    expect(warmed).toEqual(['it0', 'it2']);
  });

  it('schedules nothing for an empty list', () => {
    const w = stubWindow();
    restore = w.restore;
    prewarmIconCache([], { warm: () => {} });
    expect(w.idleQueue).toHaveLength(0);
  });
});

describe('defaultIconPrewarmEntries', () => {
  it('covers the item catalog and the ability table', () => {
    const list = defaultIconPrewarmEntries();
    expect(list.length).toBeGreaterThan(100);
    expect(list.some((e) => e.kind === 'item')).toBe(true);
    expect(list.some((e) => e.kind === 'ability')).toBe(true);
    for (const e of list) expect(typeof e.id).toBe('string');
  });
});
