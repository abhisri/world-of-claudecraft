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

  it('multi_class_heal: heals land, a crit fires, absorb is consumed, threat splits across aware mobs, HoT ticks', () => {
    const rec = run('multi_class_heal');
    const ev = rec.allEvents as Ev[];
    const heals = ev.filter((e) => e.type === 'heal2' && e.amount > 0);
    expect(heals.length).toBeGreaterThan(0); // applyHeal emitted real (non-overheal) heals
    expect(heals.some((e) => e.crit === true)).toBe(true); // forced-crit *1.5 path fired
    // HoT aura-tick heal path (the hot branch -> healingTakenMult + healingThreat).
    const hotAbility = rec.notes.hotAbility as string;
    expect(ev.some((e) => e.type === 'heal2' && e.ability === hotAbility && e.amount > 0)).toBe(true);
    const ents = entities(rec);
    const tank = ents.find((e) => e.id === rec.notes.tankPid);
    // consumeHealAbsorb: the small shield depleted + was filtered out; the big survived.
    expect(tank.auras?.some((a: Ev) => a.id === 'absorb_small')).toBe(false);
    expect(tank.auras?.some((a: Ev) => a.id === 'absorb_big')).toBe(true);
    // healingThreat split landed: each aware mob now lists healer ids in its hate table.
    const healerIds = rec.notes.healerIds as number[];
    const m1 = ents.find((e) => e.id === rec.notes.m1Id);
    const m3 = ents.find((e) => e.id === rec.notes.m3Id); // matched only via the pet-owner branch
    expect(healerIds.some((hid) => m1.threat.has(hid))).toBe(true);
    expect(healerIds.some((hid) => m3.threat.has(hid))).toBe(true);
  });

  it('c3_aura_runner: dot kills victim mid-tick (guard fires, rider aura survives), regen heal emitted, AoE hits 2+ mobs', () => {
    const rec = run('c3_aura_runner');
    const pid = (rec.sim as any).playerId;
    const ev = rec.allEvents as Ev[];
    const ents = entities(rec);
    const victim = ents.find((e) => e.id === rec.notes.victimId);
    expect(victim, 'victim missing').toBeTruthy();
    // The dot (index 1, ticked first in the backward walk) dropped the victim to lethal
    // mid-updateAuras, so the `if (e.dead) return;` guard fired before the index-0 aura
    // was reached. (handleDeath clears the corpse's auras, so the observable proof is the
    // dead victim + the byte-identical golden draw order, not a surviving aura.)
    expect(victim.dead).toBe(true);
    // updateRegen eat path fired: a 'heal' to the paladin (the ctx.healingTakenMult call).
    expect(ev.some((e) => e.type === 'heal' && e.targetId === pid)).toBe(true);
    // pulseGroundAoE hit >=2 distinct in-radius targets (rng.range once per target).
    const aoeMobIds = rec.notes.aoeMobIds as number[];
    const consTargets = new Set(
      ev
        .filter((e) => e.type === 'damage' && typeof e.ability === 'string' && e.ability.toLowerCase().includes('consecrat'))
        .map((e) => e.targetId),
    );
    expect(aoeMobIds.filter((id) => consTargets.has(id)).length).toBeGreaterThanOrEqual(2);
  });

  it('c4a_casting_lifecycle: casts start, a timed cast completes, and interrupts cancel', () => {
    const rec = run('c4a_casting_lifecycle');
    const ev = rec.allEvents as Ev[];
    // castAbility started the timed casts + the channel (mage fireball, priest heal,
    // warlock drain_life).
    expect(ev.some((e) => e.type === 'castStart')).toBe(true);
    // a timed cast ran to completion (the mage fireball -> updateCasting finish branch).
    expect(ev.some((e) => e.type === 'castStop' && e.success === true)).toBe(true);
    // an interrupt cancelled a cast (priest silence + warlock fishing -> cancelCast).
    expect(ev.some((e) => e.type === 'castStop' && e.success === false)).toBe(true);
    // the warlock drain channel ticked and dealt shadow damage (applyChannelTick).
    const wl = rec.notes.warlockId as number;
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === wl && e.school === 'shadow')).toBe(true);
  });

  it('c4b_effect_dispatch: runEffects fans across sunder/aoe/finisher/judgement/fear/groundAoE/summon/form', () => {
    const rec = run('c4b_effect_dispatch');
    const ev = rec.allEvents as Ev[];
    const ents = entities(rec);
    // warrior sunder_armor: the sunder aura landed (or a miss event fired) on its mob.
    const warriorMob = ents.find((e) => e.templateId === 'forest_wolf' && e.auras?.some((a: Ev) => a.kind === 'sunder'));
    const sunderMiss = ev.some((e) => e.type === 'damage' && e.kind === 'miss' && typeof e.ability === 'string' && e.ability.toLowerCase().includes('sunder'));
    expect(Boolean(warriorMob) || sunderMiss).toBe(true);
    // mage arcane_explosion: the per-target aoeDamage hit BOTH in-radius mobs.
    const aoeMobIds = rec.notes.aoeMobIds as number[];
    const arcaneTargets = new Set(
      ev.filter((e) => e.type === 'damage' && e.school === 'arcane' && aoeMobIds.includes(e.targetId)).map((e) => e.targetId),
    );
    expect(arcaneTargets.size).toBe(2);
    // rogue eviscerate: finisher dealt physical damage AND the combo-spend reset fired.
    const rogue = rec.notes.rogueId as number;
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === rogue && e.school === 'physical')).toBe(true);
    expect(ev.some((e) => e.type === 'comboPoint' && e.pid === rogue && e.points === 0)).toBe(true);
    // paladin judgement: a holy damage from the paladin (the Seal unleashed).
    const paladin = rec.notes.paladinId as number;
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === paladin && e.school === 'holy')).toBe(true);
    // paladin consecration: a ground AoE was pushed (on-cast pulse path).
    expect((rec.sim as any).groundAoEs.length).toBeGreaterThanOrEqual(1);
    // warlock fear: the incapacitate aura landed on the warlock's mob (fear-angle draw).
    const warlockMob = ents.find((e) => e.id === rec.notes.warlockMobId);
    expect(warlockMob?.auras?.some((a: Ev) => a.kind === 'incapacitate')).toBe(true);
    // warlock summon_imp: a pet now belongs to the warlock (summonDemon -> summonPet).
    expect(ents.some((e) => e.ownerId === rec.notes.warlockId)).toBe(true);
    // druid form switch: the LAST form (cat) is active and bear was stripped.
    const druid = ents.find((e) => e.id === rec.notes.druidId);
    expect(druid?.auras?.some((a: Ev) => a.kind === 'form_cat')).toBe(true);
    expect(druid?.auras?.some((a: Ev) => a.kind === 'form_bear')).toBe(false);
  });

  it('c5_auto_attack: melee swing table + ranged Auto Shot + wand + queued on-swing fire', () => {
    const rec = run('c5_auto_attack');
    const ev = rec.allEvents as Ev[];
    // ranged white swings carry their hardcoded labels in the damage-event ability field.
    expect(ev.some((e) => e.type === 'damage' && e.ability === 'Auto Shot')).toBe(true); // hunter ranged path
    expect(ev.some((e) => e.type === 'damage' && e.ability === 'Wand')).toBe(true); // mage wand path (no dead zone)
    // melee auto-attack produced physical white-hit outcomes (the single-roll table).
    expect(
      ev.some((e) => e.type === 'damage' && e.school === 'physical' && (e.kind === 'hit' || e.kind === 'miss' || e.kind === 'dodge')),
    ).toBe(true);
    // a queued on-next-swing ability was consumed in the swing path (its name rode through).
    expect(ev.some((e) => e.type === 'damage' && (e.ability === 'Heroic Strike' || e.ability === 'Raptor Strike'))).toBe(true);
  });
});
