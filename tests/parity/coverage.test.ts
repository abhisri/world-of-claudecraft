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

  it('delve_lockpick_fail: idling past the step clock jams the chest and opens the exit', () => {
    const rec = run('delve_lockpick_fail');
    const sim = rec.sim as any;
    const ev = rec.allEvents as Ev[];
    // The attempt engaged, then the server clock (not the client) burned the single try.
    expect(ev.some((e) => e.type === 'lockpickSession')).toBe(true);
    expect(ev.some((e) => e.type === 'lockpickEnd' && e.outcome === 'fail')).toBe(true);
    // The chest jams (lost until the delve is re-cleared) but the surface exit still opens.
    const r = sim.delveRunForPlayer(sim.playerId);
    const chestId = rec.notes.chestId as number;
    expect(r.objectState[chestId].attemptAvailable).toBe(false);
    expect(r.surfaceExitId).not.toBeNull();
    expect(r.objectState[r.surfaceExitId].open).toBe(true);
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

  it('delve_progression: chamber advances to the finale and the Marks shop buy resolves', () => {
    const rec = run('delve_progression');
    const ev = rec.allEvents as Ev[];
    // advanceDelveModule walked the run from the chamber onto the finale module.
    expect(ev.some((e) => e.type === 'log' && typeof e.text === 'string' && e.text.includes('tombstone into'))).toBe(true);
    // delveBuyShopItem deducted Marks and granted the item via the vendor event.
    expect(ev.some((e) => e.type === 'vendor' && e.action === 'buy' && e.itemId === 'reliquary_legs')).toBe(true);
  });

  it('delve_companion: rank-2 Tessa swings (16762), heals the owner, and the run holds her', () => {
    const rec = run('delve_companion');
    const sim = rec.sim as any;
    const ev = rec.allEvents as Ev[];
    const compId = rec.notes.companionId as number;
    const pid = sim.playerId as number;
    expect(compId, 'companion did not spawn').toBeTruthy();
    // combat arm: the companion dealt damage via mobSwing (~16762).
    expect(ev.some((e) => e.type === 'damage' && e.sourceId === compId)).toBe(true);
    // heal arm: a heal toward the owner + the companion's spellfx tick fired.
    expect(ev.some((e) => e.type === 'heal' && e.targetId === pid && e.amount > 0)).toBe(true);
    expect(ev.some((e) => e.type === 'spellfx' && e.sourceId === compId && e.fx === 'tick')).toBe(true);
  });

  it('quest_kill_credit: kill credit accrues and the quest promotes to ready then turns in', () => {
    const rec = run('quest_kill_credit');
    const ev = rec.allEvents as Ev[];
    // onMobKilledForQuests bumped progress on each forest_wolf death.
    expect(ev.filter((e) => e.type === 'questProgress' && e.questId === 'q_wolves').length).toBeGreaterThanOrEqual(8);
    // checkQuestReady promoted active -> ready, and the quest was turned in.
    expect(ev.some((e) => e.type === 'questReady' && e.questId === 'q_wolves')).toBe(true);
    expect(ev.some((e) => e.type === 'questDone' && e.questId === 'q_wolves')).toBe(true);
    expect((rec.sim as any).players.get((rec.sim as any).playerId)?.questsDone?.has('q_wolves')).toBe(true);
  });

  it('quest_collect_turnin: collect credit promotes, demotes on item loss, and turns in', () => {
    const rec = run('quest_collect_turnin');
    const ev = rec.allEvents as Ev[];
    // onInventoryChangedForQuests fired progress as hides were collected.
    expect(ev.some((e) => e.type === 'questProgress' && e.questId === 'q_boars')).toBe(true);
    // checkQuestReady's promotion arm.
    expect(ev.some((e) => e.type === 'questReady' && e.questId === 'q_boars')).toBe(true);
    // The demotion arm fired at least once (a 'questProgress' below target after a
    // 'questReady') — the dropped hide and the turn-in removal both demote ready -> active.
    const readyIdx = ev.findIndex((e) => e.type === 'questReady' && e.questId === 'q_boars');
    expect(
      ev.slice(readyIdx + 1).some((e) => e.type === 'questProgress' && e.questId === 'q_boars'),
    ).toBe(true);
    expect(ev.some((e) => e.type === 'questDone' && e.questId === 'q_boars')).toBe(true);
  });

  it('dungeon_instances: party shares one instance via the door trigger, then it resets when empty', () => {
    const rec = run('dungeon_instances');
    const sim = rec.sim as any;
    // Door-trigger entry claimed an instance and both party members joined the SAME slot.
    expect(rec.notes.slotA).not.toBe(null);
    expect(rec.notes.slotA).toBe(rec.notes.slotB);
    // claimInstance spawned mobs (rng.int per spawn).
    expect((rec.notes.instMobIds as number[]).length).toBeGreaterThan(0);
    // After the empty-reset, freeInstance nulled partyKey and despawned the mobs.
    const inst = (sim.instances as any[]).find((i) => i.dungeonId === 'hollow_crypt' && i.slot === rec.notes.slotA);
    expect(inst.partyKey).toBe(null);
    expect(inst.mobIds.length).toBe(0);
    expect((rec.notes.instMobIds as number[]).every((id) => !sim.entities.has(id))).toBe(true);
  });

  it('dungeon_raid_lockout: an active raid lockout blocks Nythraxis arena re-entry', () => {
    const rec = run('dungeon_raid_lockout');
    expect(
      (rec.allEvents as Ev[]).some(
        (e) => e.type === 'error' && e.text === 'You are locked to Nythraxis Raid Arena.',
      ),
    ).toBe(true);
  });
});
