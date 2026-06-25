// Direct unit tests for the SimContext seam (src/sim/sim_context.ts), installed by
// session S0b. Two layers:
//   1. createSimContext() in isolation against a FAKE host: the primitives are live
//      read-throughs, the callbacks pass through unchanged, and building/reading the
//      context draws no rng (so the seam can never perturb determinism).
//   2. The real `Sim.ctx`: every stub delegates to the still-on-Sim method of the
//      same name, and the seam leaves same-seed-same-world determinism intact.

import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../src/sim/rng';
import { Sim } from '../src/sim/sim';
import { createSimContext, type SimContextHost } from '../src/sim/sim_context';
import { SpatialGrid } from '../src/sim/spatial';
import type { Entity, SimEvent } from '../src/sim/types';

// Every cross-system callback on the seam. The list IS the contract: each must be a
// faithful pass-through to its host (and, on a real Sim, to the method of the same
// name). Keep in sync with SimContextCallbacks.
const CALLBACK_KEYS = [
  'emit',
  'dealDamage',
  'handleDeath',
  'cancelCast',
  'pushbackCast',
  'refreshMobLeashFromAction',
  'retargetMob',
  'isArenaCrossTeam',
  'arenaTeamOf',
  'endArenaMatch',
  'endDuel',
  'fiestaTakedown',
  'fiestaDown',
  'rollLoot',
  'applyHeal',
  'applyAura',
  'applyRootAura',
  'applyKnockback',
  'diminishedCrowdControlDuration',
  'hostilesInRadius',
  'breakStealth',
  'applyTaunt',
  'summonPet',
  'petOf',
  'completeTame',
  'clearEntityMarker',
  'partyOf',
  'removeFromParty',
  'onInventoryChangedForQuests',
  // E1 entity-roster surface.
  'addEntity',
  'dropEntity',
  'rebucket',
  'resolve',
  'groundPos',
  'playerMods',
  'delveRunForPlayer',
  'delveModuleEntry',
  'failDelveRun',
  'pulseGroundAoE',
  // C1 damage-core surface.
  'grantXp',
  'enterCombat',
  'hexOutputMult',
  'critVulnBonus',
  'pvpController',
  'threatMod',
  'isArenaTeamWiped',
  'arenaIsDown',
  'clearNonPlayerStatAuras',
  'delveRunForMob',
  'onDelveBossDefeated',
  'grantNythraxisLockout',
  'frenzyPackmates',
  'armDeathThroes',
  'onMobKilledForQuests',
  'refreshKnownAbilities',
  'syncPetLevel',
] as const;

// A fully-spied fake host. `clock` is mutable so a test can prove the context reads
// time/tickCount LIVE rather than snapshotting them at construction.
function makeFakeHost() {
  const rng = new Rng(123);
  const entities = new Map<number, Entity>();
  const clock = { time: 0, tick: 0 };
  const host: SimContextHost = {
    get rng() {
      return rng;
    },
    get time() {
      return clock.time;
    },
    get tickCount() {
      return clock.tick;
    },
    get entities() {
      return entities;
    },
    grid: new SpatialGrid(),
    playerGrid: new SpatialGrid(),
    delayedEvents: [],
    groundAoEs: [],
    dungeonDoorIds: null,
    arenaMatches: new Map(),
    players: new Map(),
    duels: new Map(),
    cfg: {} as SimContextHost['cfg'],
    emit: vi.fn(),
    dealDamage: vi.fn(),
    handleDeath: vi.fn(),
    cancelCast: vi.fn(),
    pushbackCast: vi.fn(),
    refreshMobLeashFromAction: vi.fn(),
    retargetMob: vi.fn(),
    isArenaCrossTeam: vi.fn(() => false),
    arenaTeamOf: vi.fn(() => null),
    endArenaMatch: vi.fn(),
    endDuel: vi.fn(),
    fiestaTakedown: vi.fn(),
    fiestaDown: vi.fn(),
    rollLoot: vi.fn(),
    applyHeal: vi.fn(),
    applyAura: vi.fn(),
    applyRootAura: vi.fn(),
    applyKnockback: vi.fn(() => 0),
    diminishedCrowdControlDuration: vi.fn(() => null),
    hostilesInRadius: vi.fn(() => []),
    breakStealth: vi.fn(),
    applyTaunt: vi.fn(),
    summonPet: vi.fn(),
    petOf: vi.fn(() => null),
    completeTame: vi.fn(),
    clearEntityMarker: vi.fn(),
    partyOf: vi.fn(() => null),
    removeFromParty: vi.fn(),
    onInventoryChangedForQuests: vi.fn(),
    addEntity: vi.fn(),
    dropEntity: vi.fn(),
    rebucket: vi.fn(),
    resolve: vi.fn(() => null),
    groundPos: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    playerMods: vi.fn(),
    delveRunForPlayer: vi.fn(() => null),
    delveModuleEntry: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    failDelveRun: vi.fn(),
    pulseGroundAoE: vi.fn(),
    grantXp: vi.fn(),
    enterCombat: vi.fn(),
    hexOutputMult: vi.fn(() => 1),
    critVulnBonus: vi.fn(() => 0),
    pvpController: vi.fn(() => null),
    threatMod: vi.fn(() => 1),
    isArenaTeamWiped: vi.fn(() => false),
    arenaIsDown: vi.fn(() => false),
    clearNonPlayerStatAuras: vi.fn(),
    delveRunForMob: vi.fn(() => null),
    onDelveBossDefeated: vi.fn(),
    grantNythraxisLockout: vi.fn(),
    frenzyPackmates: vi.fn(),
    armDeathThroes: vi.fn(),
    onMobKilledForQuests: vi.fn(),
    refreshKnownAbilities: vi.fn(),
    syncPetLevel: vi.fn(),
  };
  return { host, rng, entities, clock };
}

describe('createSimContext (isolated, fake host)', () => {
  it('exposes the host rng/entities by shared reference', () => {
    const { host, rng, entities } = makeFakeHost();
    const ctx = createSimContext(host);
    expect(ctx.rng).toBe(rng);
    expect(ctx.entities).toBe(entities);
  });

  it('reads time/tickCount LIVE, not snapshotted at construction', () => {
    const { host, clock } = makeFakeHost();
    const ctx = createSimContext(host);
    expect(ctx.time).toBe(0);
    expect(ctx.tickCount).toBe(0);
    clock.time = 12.5;
    clock.tick = 7;
    expect(ctx.time).toBe(12.5);
    expect(ctx.tickCount).toBe(7);
  });

  it('passes every callback through to the host by identity (no rewrapping)', () => {
    const { host } = makeFakeHost();
    const ctx = createSimContext(host);
    const ctxRec = ctx as unknown as Record<string, unknown>;
    const hostRec = host as unknown as Record<string, unknown>;
    for (const key of CALLBACK_KEYS) {
      expect(typeof ctxRec[key]).toBe('function');
      expect(ctxRec[key]).toBe(hostRec[key]);
    }
  });

  it('forwards call arguments and return values to the host', () => {
    const { host } = makeFakeHost();
    const ctx = createSimContext(host);
    const ev = { type: 'loot', text: 'seam-test' } as SimEvent;
    ctx.emit(ev);
    expect(host.emit).toHaveBeenCalledWith(ev);

    const src = { id: 1 } as Entity;
    const tgt = { id: 2 } as Entity;
    ctx.dealDamage(src, tgt, 9, true, 'fire', 'fireball', 'hit');
    expect(host.dealDamage).toHaveBeenCalledWith(src, tgt, 9, true, 'fire', 'fireball', 'hit');

    (host.petOf as ReturnType<typeof vi.fn>).mockReturnValueOnce(tgt);
    expect(ctx.petOf(42)).toBe(tgt);
    expect(host.petOf).toHaveBeenCalledWith(42);
  });

  it('constructs and reads without drawing rng (determinism-safe)', () => {
    const { host } = makeFakeHost();
    let draws = 0;
    host.rng.setObserver(() => {
      draws++;
    });
    const ctx = createSimContext(host);
    // Touch every primitive view; none may draw.
    void ctx.rng;
    void ctx.time;
    void ctx.tickCount;
    void ctx.entities;
    host.rng.setObserver(null);
    expect(draws).toBe(0);
  });
});

describe('Sim.ctx (real seam delegation)', () => {
  const makeSim = (seed = 42) => new Sim({ seed, playerClass: 'warrior', autoEquip: true });

  it('exposes the live shared rng/entities/time/tickCount', () => {
    const sim = makeSim();
    expect(sim.ctx.rng).toBe(sim.rng);
    expect(sim.ctx.entities).toBe(sim.entities);
    expect(sim.ctx.time).toBe(sim.time);
    expect(sim.ctx.tickCount).toBe(sim.tickCount);
    sim.tick();
    expect(sim.ctx.tickCount).toBe(1);
    expect(sim.ctx.tickCount).toBe(sim.tickCount);
    expect(sim.ctx.time).toBe(sim.time);
  });

  it('emit delegates to the Sim event queue', () => {
    const sim = makeSim();
    sim.drainEvents(); // clear any startup events
    const ev = { type: 'loot', text: 'seam-emit' } as SimEvent;
    sim.ctx.emit(ev);
    expect(sim.drainEvents()).toContain(ev);
  });

  it('read-only callbacks (partyOf/petOf) delegate to Sim', () => {
    const sim = makeSim();
    const pid = sim.primaryId;
    expect(sim.ctx.partyOf(pid)).toBe(sim.partyOf(pid));
    expect(sim.ctx.petOf(pid)).toBe(sim.petOf(pid));
  });

  it('a mutating callback (dealDamage) delegates identically to Sim.dealDamage', () => {
    const viaCtx = makeSim(7);
    const viaDirect = makeSim(7);
    const pa = viaCtx.entities.get(viaCtx.primaryId) as Entity;
    const pb = viaDirect.entities.get(viaDirect.primaryId) as Entity;
    const hp0 = pa.hp;
    expect(pb.hp).toBe(hp0); // same seed => identical start

    viaCtx.ctx.dealDamage(null, pa, 5, false, 'physical', null, 'hit');
    viaDirect.dealDamage(null, pb, 5, false, 'physical', null, 'hit');

    expect(pa.hp).toBe(pb.hp); // delegation is identical to calling Sim directly
    expect(pa.hp).toBeLessThan(hp0); // and it actually applied damage (non-vacuous)
  });

  it('does not perturb determinism (same seed -> same world through the seam)', () => {
    const run = () => {
      const sim = makeSim(7);
      for (let i = 0; i < 40; i++) sim.tick();
      const p = sim.entities.get(sim.primaryId) as Entity;
      return { time: sim.ctx.time, tick: sim.ctx.tickCount, hp: p.hp, pos: { ...p.pos } };
    };
    expect(run()).toEqual(run());
  });
});
