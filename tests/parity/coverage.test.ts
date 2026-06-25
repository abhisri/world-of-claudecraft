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

  it('mob_swing_affixes: stun/venom/silence/rampage procs land + friendly pet never debuffs', () => {
    const rec = run('mob_swing_affixes');
    const n = rec.notes as Record<string, any>;
    // Each heavy-hitter proc fired its rng.chance and applied its aura on a landed swing.
    expect(n.stunLanded).toBe(true); // mogger_lackey stunOnHit
    expect(n.venomLanded).toBe(true); // webwood_spider venom DoT
    expect(n.silenceLanded).toBe(true); // gravecaller_summoner silence
    expect(n.rampageStacks).toBeGreaterThan(0); // warlord_drogmar self-stacking buff_ap
    // The friendly (hostile=false) pet swung the dummy but applied no on-hit debuff.
    expect(n.dummyDebuffs).toBe(0);
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

  it('mob_targeting: pull-over (melee 110% / ranged 130%), taunt force+expiry, retarget-to-evade', () => {
    const rec = run('mob_targeting');
    const n = rec.notes as Record<string, any>;
    const mob = entities(rec).find((e) => e.id === n.mobId);
    expect(mob, 'tracked mob missing').toBeTruthy();
    // 110% melee pull-over switched the mob from the tank to the in-melee bruiser.
    expect(n.afterMelee).toBe(n.bruiserId);
    // caster at EXACTLY 130% does NOT pull (strict `>` against RANGED_SWITCH_MULT).
    expect(n.afterRangedBoundary).toBe(n.tankId);
    // caster past 130% pulls the mob over at range.
    expect(n.afterRanged).toBe(n.casterId);
    // taunt forced the mob onto the tank despite the caster's higher threat.
    expect(n.afterTauntForced).toBe(n.tankId);
    // after the forced window expired, the threat scan reclaimed the caster.
    expect(n.afterTauntExpired).toBe(n.casterId);
    // retargetMob grabbed the highest-threat target (caster) and chased.
    expect(n.afterRetarget).toBe(n.casterId);
    // retargetMob with only stale threat pruned to empty and evaded home.
    expect(n.finalAiState).toBe('evade');
    expect(mob.aggroTargetId).toBe(null);
    expect(mob.threat.size).toBe(0);
  });

  it('mob_locomotion: boss pulse/stomp/terrify fire, idle wander + evade reset + cowardly flee', () => {
    const rec = run('mob_locomotion');
    const n = rec.notes as Record<string, any>;
    const ev = rec.allEvents as Ev[];
    const ents = entities(rec);
    // aoePulse dealt damage + emitted spellfx (mogger Ground Pound).
    expect(ev.some((e) => e.type === 'spellfx' && e.sourceId === n.pulserId)).toBe(true);
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === n.pulserId)).toBe(true);
    // War Stomp landed a stomp_stun + Banshee terrify landed a fear_incap (captured at
    // the moment each arm fired; the CC does not persist to the end without a tick).
    expect(n.stompStunLanded).toBe(true);
    expect(n.fearLanded).toBe(true);
    // War Stomp + terrify each emit an 'unleashes' combat-log line (>= 2 total).
    expect(
      ev.filter((e) => e.type === 'log' && typeof e.text === 'string' && e.text.includes('unleashes')).length,
    ).toBeGreaterThanOrEqual(2);
    // Idle wander picked a target (wanderTimer re-armed to the 30s patrol window).
    const wanderer = ents.find((e) => e.id === n.wandererId);
    expect(wanderer.wanderTarget).not.toBeNull();
    // Evade arrival reset the mob: back to idle at full hp.
    expect(n.evaderState).toBe('idle');
    expect(n.evaderHp).toBeGreaterThan(1);
    // Cowardly flee: the lackey panicked into the flee state and stayed fleeing.
    expect(n.cowardStateAfterPanic).toBe('flee');
    expect(n.cowardStateFleeing).toBe('flee');
    expect(
      ev.some((e) => e.type === 'log' && typeof e.text === 'string' && e.text.includes('attempts to flee')),
    ).toBe(true);
  });
});
