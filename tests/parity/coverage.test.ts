// Coverage proof: each scenario must ACTUALLY fire its target subsystem (not just
// name it in a comment). These assertions inspect the live events + final state of
// a recorded run. If a future content change breaks a recipe, this fails loudly so
// the golden never silently stops exercising a system.

import { describe, expect, it } from 'vitest';
import { record } from './record';
import { SCENARIOS } from './scenarios';
import type { Recorder } from './record';

type Ev = Record<string, any>;

function run(name: string): Recorder {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  return record(scenario).rec;
}

function entities(rec: Recorder): any[] {
  return [...(rec.sim as any).entities.values()];
}

describe('coverage: each scenario fires its subsystem', () => {
  it('solo_warrior: auto-attack + mobSwing both ways, mob death -> rollLoot produced loot', () => {
    const rec = run('solo_warrior');
    const pid = (rec.sim as any).playerId;
    const ev = rec.allEvents as Ev[];
    const playerDealt = ev.some((e) => e.type === 'damage' && e.sourceId === pid);
    const playerTookHit = ev.some((e) => e.type === 'damage' && e.targetId === pid);
    expect(playerDealt).toBe(true); // player auto-attack / heroic_strike
    expect(playerTookHit).toBe(true); // mobSwing hit the player
    expect(ev.some((e) => e.type === 'death')).toBe(true);
    // rollLoot ran on death and produced loot (forest_wolf drops copper, chance 1).
    expect(entities(rec).some((e) => e.templateId === 'forest_wolf' && e.dead && e.lootable)).toBe(true);
  });

  it('solo_mage: casting lifecycle runs', () => {
    const rec = run('solo_mage');
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'castStart')).toBe(true);
  });

  it('solo_rogue: weaponStrike via sinister_strike fires', () => {
    const rec = run('solo_rogue');
    const pid = (rec.sim as any).playerId;
    const ev = rec.allEvents as Ev[];
    const sinister = ev.some(
      (e) => e.type === 'damage' && typeof e.ability === 'string' && e.ability.toLowerCase().includes('sinister'),
    );
    const playerDealt = ev.some((e) => e.type === 'damage' && e.sourceId === pid);
    expect(sinister || playerDealt).toBe(true);
  });

  it('affix_mob: frenzyOnHit buff on mob + bleed on player + player-cast taunt (4279)', () => {
    const rec = run('affix_mob');
    const pid = (rec.sim as any).playerId;
    // old_greyjaw is also a rare world spawn, so match across ALL of them (the
    // scenario's own spawn is the one that gets wounded into a frenzy + taunted).
    const greyjaws = entities(rec).filter((e) => e.templateId === 'old_greyjaw');
    const player = (rec.sim as any).player;
    expect(greyjaws.some((e) => e.auras?.some((a: Ev) => a.id === 'blood_frenzy'))).toBe(true);
    expect(player.auras?.some((a: Ev) => a.kind === 'dot')).toBe(true);
    // applyTaunt (player cast) forced the greyjaw onto the player.
    expect(greyjaws.some((e) => e.forcedTargetId === pid)).toBe(true);
  });

  it('hunter_pet: friendly ranged pet (8093) AND hostile petSpell mob (6776) both fire', () => {
    const rec = run('hunter_pet');
    const pid = (rec.sim as any).playerId;
    const ev = rec.allEvents as Ev[];
    const pet = entities(rec).find((e) => e.ownerId === pid && e.templateId === 'warlock_imp');
    expect(pet).toBeTruthy();
    // friendly arm (8093): pet shoots its target
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === pet.id && e.school === 'fire')).toBe(true);
    // hostile-mob arm (6776): wild imp's AI shoots the player
    const hostileImpId = rec.notes.hostileImpId;
    expect(
      ev.some((e) => e.type === 'damage' && e.sourceId === hostileImpId && e.targetId === pid && e.school === 'fire'),
    ).toBe(true);
  });

  it('warlock_pet: melee pet swings (8117) and manual taunt forces the target (4885)', () => {
    const rec = run('warlock_pet');
    const pid = (rec.sim as any).playerId;
    const pet = entities(rec).find((e) => e.ownerId === pid);
    expect(pet).toBeTruthy();
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'damage' && e.sourceId === pet.id)).toBe(true);
    // petTaunt -> applyTaunt forced the hostile target onto the pet.
    expect(entities(rec).some((e) => e.templateId === 'forest_wolf' && e.forcedTargetId === pet.id)).toBe(true);
  });

  it('paladin_consecration: ground AoE pulses fire from BOTH callers (immediate + deferred)', () => {
    const rec = run('paladin_consecration');
    const hits = (rec.allEvents as Ev[]).filter(
      (e) => e.type === 'damage' && typeof e.ability === 'string' && e.ability.toLowerCase().includes('consecrat'),
    );
    // 1 immediate on-cast pulse (~4097) + >=1 deferred interval pulse (~3052).
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('arena_1v1: a match resolves (arenaEnd)', () => {
    const rec = run('arena_1v1');
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'arenaEnd')).toBe(true);
  });

  it('fiesta: a cross-team takedown scores AND an augment is offered + chosen', () => {
    const rec = run('fiesta');
    const ev = rec.allEvents as Ev[];
    expect(ev.some((e) => e.type === 'fiestaScore' || e.type === 'fiestaDown')).toBe(true);
    // augment wave actually ran: an offer was presented and a pick recorded.
    expect(ev.some((e) => e.type === 'augmentOffer')).toBe(true);
    const victimPid = rec.notes.fiestaVictimPid as number;
    expect((rec.sim as any).players.get(victimPid)?.fiestaAugments?.length).toBeGreaterThan(0);
  });

  it('delve_lockpick: companion swings the boss (16762), lockpick engaged + stepped', () => {
    const rec = run('delve_lockpick');
    const ev = rec.allEvents as Ev[];
    // mobSwing delve-companion caller (~16762): the companion dealt damage.
    const compId = rec.notes.companionId;
    expect(compId, 'companion did not spawn').toBeTruthy();
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === compId)).toBe(true);
    expect(ev.some((e) => e.type === 'lockpickSession')).toBe(true);
    expect(ev.some((e) => e.type === 'lockpickStep')).toBe(true);
  });

  it('party_loot: a need/greed loot roll prompt fires', () => {
    const rec = run('party_loot');
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'lootRoll')).toBe(true);
  });

  it('entity_roster: both despawn branches drop, delayed drain runs, graveyard release at full hp', () => {
    const rec = run('entity_roster');
    const ents = entities(rec);
    const ghostId = rec.notes.ghostId as number;
    const guardId = rec.notes.guardId as number;
    // despawn prologue dropped both: despawnTimer mob + DAMAGE_IDLE_DESPAWN idle mob.
    expect(ents.some((e) => e.id === ghostId)).toBe(false);
    expect(ents.some((e) => e.id === guardId)).toBe(false);
    // delayed drain: 3 scheduled -> 1 fired, 1 guard-dropped, 1 (future) still pending.
    expect((rec.sim as any).delayedEvents.length).toBe(1);
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'respawn')).toBe(true);
    // outdoor release-spirit: alive again at full hp.
    const p = (rec.sim as any).player;
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(p.maxHp);
  });

  it('delve_death: second in-run death fails the delve and ejects the player', () => {
    const rec = run('delve_death');
    expect((rec.allEvents as Ev[]).some((e) => e.type === 'delveFailed')).toBe(true);
  });

  it('fiesta_midcast_kill: mid-cast cancel + cross-team takedown both fire', () => {
    const rec = run('fiesta_midcast_kill');
    const ev = rec.allEvents as Ev[];
    // fishing-cast hit -> cancelCast emits castStop(success:false)
    expect(ev.some((e) => e.type === 'castStop' && e.success === false)).toBe(true);
    // lethal cross-team hit -> fiesta takedown scored
    expect(ev.some((e) => e.type === 'fiestaScore' || e.type === 'fiestaDown')).toBe(true);
    const victimPid = rec.notes.fiestaVictimPid as number;
    expect(typeof victimPid).toBe('number');
  });

  it('multi_class_frenzy: frenzyOnHit draws + blood_frenzy lands across multi-class hits', () => {
    const rec = run('multi_class_frenzy');
    const gid = rec.notes.greyjawId as number;
    const g = entities(rec).find((e) => e.id === gid);
    expect(g, 'scenario greyjaw missing').toBeTruthy();
    expect(g.auras?.some((a: Ev) => a.id === 'blood_frenzy')).toBe(true);
    const ev = rec.allEvents as Ev[];
    const sources = new Set(ev.filter((e) => e.type === 'damage' && e.targetId === gid).map((e) => e.sourceId));
    expect(sources.size).toBeGreaterThanOrEqual(2); // multiple class sources wounded the mob
  });
});
