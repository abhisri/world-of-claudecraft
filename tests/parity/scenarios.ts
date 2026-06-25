// Parity scenarios: deterministic, seed-pinned drives that exercise the sim's
// behavior so that any future extraction is checked against a committed golden.
//
// Coverage matrix (every item is mandatory per the S0a brief):
//  - multiple classes:        warrior / mage / rogue / hunter / warlock / paladin
//  - meleeSwing weaponStrike:  heroic_strike (warrior), sinister_strike (rogue)
//  - auto-attack + mobSwing:   solo_warrior (mob swings back)
//  - frenzy + on-hit affix:    affix_mob (old_greyjaw frenzyOnHit + ridge_stalker bleed)
//  - pets:                     hunter_pet (updateRangedPetAttack), warlock_pet (mobSwing pet arm + applyTaunt)
//  - ground-AoE:               paladin_consecration (updateGroundAoEs first + pulseGroundAoE both callers)
//  - arena + fiesta:           arena_1v1, fiesta
//  - delve + lockpick:         delve_lockpick
//  - loot roll:                solo_warrior (death->rollLoot), party_loot (need/greed)
//
// All drives are MOVE-safe: they only call public Sim methods + the documented
// internal plumbing the existing tests use (createMob/addEntity, dealDamage,
// mobSwing, spawnDelveModule), never reaching into not-yet-extracted internals
// in a way the sim itself does not already expose.

import { MOBS, DELVES } from '../../src/sim/data';
import { createMob } from '../../src/sim/entity';
import { Sim } from '../../src/sim/sim';
import { solveLockActions } from '../../src/sim/lockpick';
import { FISHING_CAST_ID } from '../../src/sim/types';
import type { Aura, Entity } from '../../src/sim/types';
import { terrainHeight } from '../../src/sim/world';
import type { Recorder, Scenario } from './record';

// ----- shared helpers ---------------------------------------------------------

type AnySim = Sim & Record<string, any>;
type AnyEntity = Entity & Record<string, any>;

// Move an entity to (x,z) on the terrain and keep the spatial grid consistent —
// the same idiom every existing scenario test uses.
function teleport(sim: AnySim, e: AnyEntity, x: number, z: number): void {
  e.pos.x = x;
  e.pos.z = z;
  e.pos.y = terrainHeight(x, z, sim.cfg.seed);
  e.prevPos = { ...e.pos };
  e.vx = 0;
  e.vy = 0;
  e.vz = 0;
  e.onGround = true;
  e.fallStartY = e.pos.y;
  sim.rebucket(e);
}

// Spawn a mob from a template key and register it (entities + spatial grid),
// allocating a fresh id from nextId so it never collides with ctor spawns.
function spawnMob(sim: AnySim, key: string, level: number, x: number, y: number, z: number): AnyEntity {
  const mob = createMob(sim.nextId++, MOBS[key], level, { x, y, z }) as AnyEntity;
  sim.addEntity(mob);
  return mob;
}

// Face `e` toward `target` (sim uses atan2(dx, dz), 0 = +Z).
function face(e: AnyEntity, target: AnyEntity): void {
  e.facing = Math.atan2(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
}

// Make an entity a damage sponge so a scenario can run long enough to fire its
// target path repeatedly without anyone dying early.
function beef(e: AnyEntity, hp = 50000): void {
  e.maxHp = hp;
  e.hp = hp;
}

// Aggro `mob` onto `target` so the mob's tick AI drives real mobSwing calls.
function aggroOnto(mob: AnyEntity, target: AnyEntity): void {
  mob.hostile = true;
  mob.aiState = 'attack';
  mob.aggroTargetId = target.id;
  mob.targetId = target.id;
}

const lethal = (sim: AnySim, src: AnyEntity | null, target: AnyEntity): void => {
  sim.dealDamage(src, target, target.maxHp + 1000, false, 'physical', null, 'hit', true);
};

// ----- scenarios --------------------------------------------------------------

// Warrior: auto-attack + heroic_strike (the castAbility -> meleeSwing weaponStrike
// entry) against a mob that swings back (base mobSwing), then a lethal blow that
// runs the death -> rollLoot path.
function soloWarrior(): Scenario {
  return {
    name: 'solo_warrior',
    coverage: [
      'class:warrior',
      'meleeSwing weaponStrike (heroic_strike via castAbility ~3736)',
      'player auto-attack (C5)',
      'base mobSwing (mob swings the player)',
      'rollLoot via mob death (L1, ~5876/6036)',
    ],
    build: () => new Sim({ seed: 1001, playerClass: 'warrior', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(10);
      const p = sim.player as AnyEntity;
      beef(p);
      const mob = spawnMob(sim, 'forest_wolf', 2, p.pos.x + 2, p.pos.y, p.pos.z);
      beef(mob, 6000);
      rec.track(mob.id);
      teleport(sim, p, mob.pos.x - 1.5, mob.pos.z);
      face(p, mob);
      sim.targetEntity(mob.id);
      aggroOnto(mob, p);
      sim.startAutoAttack();
      for (let round = 0; round < 6; round++) {
        p.resource = p.maxResource; // keep rage for heroic_strike
        if (p.gcdRemaining <= 0 && !p.castingAbility) sim.castAbility('heroic_strike');
        rec.tick(12);
        face(p, mob);
      }
      // Death -> credit -> rollLoot.
      mob.hp = mob.maxHp;
      lethal(sim, p, mob);
      rec.snapshot('kill');
      rec.tick(4);
    },
  };
}

// Mage: the casting lifecycle (cast time -> effect dispatch -> spell damage)
// driven by repeated fireball/frostbolt at a ranged target.
function soloMage(): Scenario {
  return {
    name: 'solo_mage',
    coverage: ['class:mage (caster)', 'casting lifecycle (C4a)', 'effect dispatch + spell damage (C4b/C1)'],
    build: () => new Sim({ seed: 1002, playerClass: 'mage', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(10);
      const p = sim.player as AnyEntity;
      beef(p);
      const mob = spawnMob(sim, 'forest_wolf', 5, p.pos.x, p.pos.y, p.pos.z + 18);
      beef(mob, 9000);
      rec.track(mob.id);
      face(p, mob);
      sim.targetEntity(mob.id);
      const spells = ['fireball', 'frostbolt'];
      for (let round = 0; round < 8; round++) {
        p.resource = p.maxResource; // mana
        if (p.gcdRemaining <= 0 && !p.castingAbility) sim.castAbility(spells[round % spells.length]);
        rec.tick(16);
        face(p, mob);
      }
    },
  };
}

// Rogue: sinister_strike (another castAbility -> meleeSwing weaponStrike entry)
// building combo points.
function soloRogue(): Scenario {
  return {
    name: 'solo_rogue',
    coverage: ['class:rogue', 'meleeSwing weaponStrike (sinister_strike via castAbility ~3736)', 'combo points'],
    build: () => new Sim({ seed: 1003, playerClass: 'rogue', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(10);
      const p = sim.player as AnyEntity;
      beef(p);
      const mob = spawnMob(sim, 'forest_wolf', 5, p.pos.x + 2, p.pos.y, p.pos.z);
      beef(mob, 9000);
      rec.track(mob.id);
      teleport(sim, p, mob.pos.x - 1.5, mob.pos.z);
      face(p, mob);
      sim.targetEntity(mob.id);
      aggroOnto(mob, p);
      sim.startAutoAttack();
      for (let round = 0; round < 6; round++) {
        p.resource = p.maxResource; // energy
        if (p.gcdRemaining <= 0 && !p.castingAbility) sim.castAbility('sinister_strike');
        rec.tick(12);
        face(p, mob);
      }
    },
  };
}

// Frenzy + on-hit affix cascade: the player hits old_greyjaw (frenzyOnHit ->
// blood_frenzy buff) while ridge_stalker swings the player (bleed on-hit affix).
// Both procs are forced deterministically by pinning the affix chance to 1 (which
// still draws rng through the real path, so the draw log stays meaningful) and
// restored afterward so the shared MOBS table is left untouched.
function affixMob(): Scenario {
  return {
    name: 'affix_mob',
    coverage: [
      'frenzyOnHit (old_greyjaw -> blood_frenzy)',
      'on-hit affix cascade via mobSwing (ridge_stalker bleed, ~7070/7100)',
      'applyTaunt player-cast arm (taunt ability, ~4279)',
      'class:warrior',
    ],
    build: () => new Sim({ seed: 1004, playerClass: 'warrior', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(13);
      const p = sim.player as AnyEntity;
      beef(p, 90000);
      const greyjaw = spawnMob(sim, 'old_greyjaw', 4, p.pos.x + 2, p.pos.y, p.pos.z);
      const stalker = spawnMob(sim, 'ridge_stalker', 13, p.pos.x - 2, p.pos.y, p.pos.z);
      beef(greyjaw, 60000);
      beef(stalker, 60000);
      aggroOnto(greyjaw, p);
      aggroOnto(stalker, p);
      rec.track(greyjaw.id, stalker.id);
      teleport(sim, p, greyjaw.pos.x - 1.5, greyjaw.pos.z);

      const greyTrait = MOBS.old_greyjaw.frenzyOnHit;
      const stalkBleed = MOBS.ridge_stalker.bleed;
      const greyOrig = greyTrait ? greyTrait.chance : undefined;
      const bleedOrig = stalkBleed ? stalkBleed.chance : undefined;
      try {
        // Inside the try so the finally restore covers every path (MOBS is a
        // process-wide singleton shared across all scenarios in one test run).
        if (greyTrait) greyTrait.chance = 1;
        if (stalkBleed) stalkBleed.chance = 1;
        for (let round = 0; round < 5; round++) {
          // player wounds greyjaw -> frenzyOnHit proc (source !== target)
          sim.dealDamage(p, greyjaw, 40, false, 'physical', null, 'hit', true);
          // stalker swings player -> bleed on-hit affix (direct, the exerciser path)
          sim.mobSwing(stalker, p);
          rec.tick(10);
        }
      } finally {
        if (greyTrait && greyOrig !== undefined) greyTrait.chance = greyOrig;
        if (stalkBleed && bleedOrig !== undefined) stalkBleed.chance = bleedOrig;
      }
      // Player-cast taunt on the (still-alive, beefed) greyjaw -> applyTaunt ~4279.
      sim.targetEntity(greyjaw.id);
      sim.castAbility('taunt');
      rec.snapshot('taunt');
      rec.tick(4);
    },
  };
}

// Ranged pet spell path, BOTH callers of updateRangedPetAttack:
//  - friendly arm (~8093): a ranged_dps pet (warlock_imp: petSpell Firebolt)
//    adopted onto the hunter.
//  - hostile mob arm (~6776): a WILD warlock_imp (ownerId null) whose attack-state
//    AI fires its petSpell at the player.
function hunterPet(): Scenario {
  return {
    name: 'hunter_pet',
    coverage: [
      'class:hunter',
      'updateRangedPetAttack friendly pet arm (~8093/8217)',
      'updateRangedPetAttack hostile-mob arm (~6776)',
    ],
    build: () => new Sim({ seed: 1005, playerClass: 'hunter', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(12);
      const p = sim.player as AnyEntity;
      beef(p);
      const pet = spawnMob(sim, 'warlock_imp', 8, p.pos.x + 1, p.pos.y, p.pos.z);
      pet.ownerId = p.id;
      pet.hostile = false;
      pet.hp = pet.maxHp;
      pet.petMode = 'aggressive';
      rec.track(pet.id);
      const target = spawnMob(sim, 'forest_wolf', 8, p.pos.x + 7, p.pos.y, p.pos.z);
      beef(target);
      aggroOnto(target, p);
      pet.aggroTargetId = target.id;
      rec.track(target.id);
      // A wild (hostile, un-owned) petSpell mob whose AI shoots the player -> 6776.
      const hostileImp = spawnMob(sim, 'warlock_imp', 8, p.pos.x - 8, p.pos.y, p.pos.z);
      hostileImp.ownerId = null;
      beef(hostileImp);
      aggroOnto(hostileImp, p);
      rec.track(hostileImp.id);
      rec.notes.hostileImpId = hostileImp.id;
      sim.targetEntity(target.id);
      sim.startAutoAttack();
      rec.tick(120); // 6s: friendly Firebolt every 2s + hostile imp shoots the player
    },
  };
}

// Warlock melee pet: summon_voidwalker (melee_tank) swings through the pet arm of
// mobSwing and taunts via the applyTaunt pet arm.
function warlockPet(): Scenario {
  return {
    name: 'warlock_pet',
    coverage: [
      'class:warlock (caster)',
      'mobSwing pet arm (voidwalker melee ~8117)',
      'applyTaunt pet auto-taunt arm (~8110)',
      'applyTaunt pet manual-taunt arm (petTaunt, ~4885)',
    ],
    build: () => new Sim({ seed: 1006, playerClass: 'warlock', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(12);
      const p = sim.player as AnyEntity;
      beef(p);
      p.resource = p.maxResource;
      sim.castAbility('summon_voidwalker');
      for (let i = 0; i < 20 * 12 && p.castingAbility; i++) rec.tick(1);
      const pet = sim.petOf(sim.playerId) as AnyEntity | null;
      if (pet) {
        rec.track(pet.id);
        pet.petMode = 'aggressive';
        pet.petAutoTaunt = true;
        pet.petTauntTimer = 0;
      }
      const target = spawnMob(sim, 'forest_wolf', 8, p.pos.x + 5, p.pos.y, p.pos.z);
      beef(target);
      aggroOnto(target, p);
      if (pet) pet.aggroTargetId = target.id;
      rec.track(target.id);
      sim.targetEntity(target.id);
      sim.startAutoAttack();
      rec.tick(120);
      // Manual pet taunt: place the pet in PET_TAUNT_RANGE (5) and command it ->
      // applyTaunt via petTaunt (~4885), distinct from the auto-taunt arm (~8110).
      if (pet) {
        pet.pos = { x: target.pos.x - 1, y: target.pos.y, z: target.pos.z };
        pet.prevPos = { ...pet.pos };
        sim.rebucket(pet);
        pet.petTauntTimer = 0;
        sim.petTaunt();
        rec.snapshot('pet-taunt');
        rec.tick(4);
      }
    },
  };
}

// Paladin Consecration: a ground AoE so updateGroundAoEs (which runs FIRST in the
// tick) and pulseGroundAoE fire from BOTH callers (the immediate on-cast pulse and
// the deferred interval pulses).
function paladinConsecration(): Scenario {
  return {
    name: 'paladin_consecration',
    coverage: [
      'class:paladin',
      'updateGroundAoEs first-in-tick (~2256)',
      'pulseGroundAoE both callers (immediate ~4097 + deferred ~3052)',
    ],
    build: () => new Sim({ seed: 1007, playerClass: 'paladin', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(20); // consecration learnLevel 18
      const p = sim.player as AnyEntity;
      beef(p);
      const mob = spawnMob(sim, 'forest_wolf', 5, p.pos.x, p.pos.y, p.pos.z + 3);
      beef(mob, 40000);
      mob.hostile = true;
      rec.track(mob.id);
      teleport(sim, p, mob.pos.x, mob.pos.z - 2); // mob within the 8yd radius
      sim.targetEntity(mob.id);
      p.resource = p.maxResource;
      rec.tick(1);
      p.gcdRemaining = 0;
      sim.castAbility('consecration'); // pushes the ground AoE; immediate pulse fires
      rec.tick(20 * 10); // 10s: interval-2 deferred pulses
    },
  };
}

// Arena 1v1: queue two solos, run the countdown to active, then force a kill so
// the Elo result lands on both players' PlayerMeta (arenaRating/Wins/Losses).
function arena1v1(): Scenario {
  return {
    name: 'arena_1v1',
    coverage: ['arena 1v1 match + Elo result', 'multi-player PlayerMeta sampling', 'classes:warrior,mage'],
    sampleEvery: 25,
    build: () => new Sim({ seed: 1008, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const a = sim.addPlayer('warrior', 'Aleph');
      const b = sim.addPlayer('mage', 'Bet');
      teleport(sim, sim.entities.get(a)!, 0, -40);
      teleport(sim, sim.entities.get(b)!, 6, -40);
      sim.arenaQueueJoin(a);
      sim.arenaQueueJoin(b);
      rec.tick(1); // matchmake
      for (let i = 0; i < 20 * 8; i++) {
        rec.tick(1);
        const m = sim.arenaMatchFor(a);
        if (m && m.state === 'active') break;
      }
      const ea = sim.entities.get(a) as AnyEntity;
      const eb = sim.entities.get(b) as AnyEntity;
      sim.dealDamage(ea, eb, 99999, false, 'physical', null, 'hit');
      rec.tick(1); // arenaEnd + rating update
      rec.tick(20 * 2);
    },
  };
}

// Fiesta: queue four solos into the score-based 2v2 party mode, run to active,
// then force a cross-team kill (scores a point + benches the victim on a respawn
// timer). Exercises fiesta match logic; the fiesta sub-stream's effects surface
// through PlayerMeta + match state.
function fiesta(): Scenario {
  return {
    name: 'fiesta',
    coverage: [
      'fiesta match (2v2 score mode)',
      'cross-team takedown + respawn bench',
      'augment wave: fiestaPickOffers + arenaAugmentPick (fiestaAugments on meta + augmentOffer/Chosen events)',
      'multi-player meta',
    ],
    sampleEvery: 25,
    build: () => new Sim({ seed: 1009, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const classes: Array<'warrior' | 'mage' | 'rogue' | 'hunter'> = ['warrior', 'mage', 'rogue', 'hunter'];
      const pids = classes.map((c, i) => sim.addPlayer(c, `P${i}`));
      pids.forEach((pid, i) => teleport(sim, sim.entities.get(pid)!, i * 4, -40));
      pids.forEach((pid) => sim.arenaQueueJoin(pid, 'fiesta'));
      rec.tick(1);
      for (let i = 0; i < 20 * 10; i++) {
        rec.tick(1);
        const m = sim.arenaMatchFor(pids[0]);
        if (m && m.state === 'active') break;
      }
      const match = sim.arenaMatchFor(pids[0]);
      if (match && match.fiesta && match.teamA.length && match.teamB.length) {
        const victimPid = match.teamB[0];
        const killer = sim.entities.get(match.teamA[0]) as AnyEntity;
        const victim = sim.entities.get(victimPid) as AnyEntity;
        // 6-arg form (kind defaulted) matches how the fiesta test drives a takedown.
        (sim as any).dealDamage(killer, victim, victim.maxHp + 50, false, 'physical', null);
        rec.tick(1); // fiestaDown + score; victim is now benched (down)
        // Open an augment wave: the downed victim is offered augments (drawing the
        // fiesta sub-stream via fiestaPickOffers), then picks one -> fiestaAugments.
        (sim as any).fiestaOpenWave(match);
        const offer = match.fiesta.offers.get(victimPid);
        if (offer && offer.choices.length) sim.arenaAugmentPick(offer.choices[0], victimPid);
        rec.notes.fiestaVictimPid = victimPid;
        rec.tick(1);
      }
      rec.tick(20 * 3);
    },
  };
}

// Delve + lockpick: enter the Collapsed Reliquary finale, pin the module so it is
// deterministic, kill the boss, then pick the reward chest flawlessly. Exercises
// the delve run progression, the lockpick minigame, and the reward-chest loot.
function delveLockpick(): Scenario {
  return {
    name: 'delve_lockpick',
    coverage: [
      'delve run (collapsed_reliquary finale)',
      'mobSwing delve-companion caller (~16762)',
      'lockpick minigame (flawless solve)',
      'reward chest + delve marks',
    ],
    sampleEvery: 10,
    build: () => new Sim({ seed: 1010, playerClass: 'rogue', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const def = DELVES.collapsed_reliquary;
      sim.setPlayerLevel(def.minLevel);
      const p = sim.player as AnyEntity;
      beef(p);
      teleport(sim, p, def.doorPos.x, def.doorPos.z);
      sim.enterDelve('collapsed_reliquary', 'normal');
      const run = sim.delveRunForPlayer(sim.playerId);
      if (!run) {
        rec.tick(2);
        return;
      }
      run.bountiful = false; // pin against the rare coffer roll
      run.modules = ['reliquary_finale'];
      run.moduleIndex = 0;
      (sim as any).spawnDelveModule(run);
      const boss = [...sim.entities.values()].find((e: AnyEntity) => e.templateId === 'deacon_varric') as
        | AnyEntity
        | undefined;
      // Let the auto-spawned delve companion swing the boss -> mobSwing companion
      // caller (~16762) before we kill it. The companion prefers the owner's target.
      const comp = run.companion ? (sim.entities.get(run.companion.entityId) as AnyEntity | undefined) : undefined;
      if (boss && comp) {
        boss.hostile = true;
        comp.pos = { x: boss.pos.x + 1, y: boss.pos.y, z: boss.pos.z };
        comp.prevPos = { ...comp.pos };
        comp.swingTimer = 0;
        sim.rebucket(comp);
        sim.targetEntity(boss.id);
        rec.track(comp.id, boss.id);
        rec.notes.companionId = comp.id;
        rec.tick(30); // companion swings the boss
      }
      if (boss) {
        rec.track(boss.id);
        lethal(sim, p, boss);
      }
      rec.tick(4); // reward chest spawns
      const chestId = run.rewardChestId;
      if (chestId != null) {
        rec.track(chestId);
        const chest = sim.entities.get(chestId) as AnyEntity;
        p.pos = { ...chest.pos };
        p.prevPos = { ...chest.pos };
        sim.rebucket(p);
        sim.lockpickEngage(chestId, 1);
        rec.tick(1);
        let guard = 0;
        while (run.lockpick && run.lockpick.state === 'IN_PROGRESS' && guard++ < 50) {
          const actions = solveLockActions(run.lockpick.pages[run.lockpick.pageIndex]);
          if (!actions || actions.length === 0) break;
          for (const action of actions) sim.lockpickAction(action);
          rec.tick(1);
        }
      }
      rec.snapshot('delve-end');
      rec.tick(2);
    },
  };
}

// Party loot: a need/greed roll over a party-tagged corpse carrying a premium
// item. Exercises lootCorpse -> lootRoll -> submitLootRoll resolution.
function partyLoot(): Scenario {
  return {
    name: 'party_loot',
    coverage: ['party need/greed loot roll (lootCorpse/submitLootRoll)', 'multi-player party'],
    build: () => new Sim({ seed: 1011, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const a = sim.addPlayer('warrior', 'Aaa');
      const b = sim.addPlayer('mage', 'Bbb');
      sim.partyInvite(b, a);
      sim.partyAccept(b);
      teleport(sim, sim.entities.get(a)!, 20, 20);
      teleport(sim, sim.entities.get(b)!, 21, 20);
      const mob = createMob(sim.nextId++, MOBS.forest_wolf, 2, {
        x: 20,
        y: terrainHeight(20, 22, sim.cfg.seed),
        z: 22,
      }) as AnyEntity;
      mob.dead = true;
      mob.lootable = true;
      mob.tappedById = a;
      mob.loot = { copper: 0, items: [{ itemId: 'greyjaw_hide_boots', count: 1 }] };
      sim.addEntity(mob);
      rec.track(mob.id);
      sim.lootCorpse(mob.id, a);
      rec.tick(1);
      const rollEv = rec.allEvents.find((e: any) => e.type === 'lootRoll') as any;
      if (rollEv) {
        sim.submitLootRoll(rollEv.rollId, 'need', a);
        sim.submitLootRoll(rollEv.rollId, 'need', b);
      }
      rec.tick(2);
    },
  };
}

// Entity roster (E1): the spawn/despawn/decay plumbing, the delayed-event drain,
// and the outdoor player release-spirit path. Spawns mobs via addEntity, expires
// them through BOTH despawn branches (despawnTimer + the idle-despawn timer on a
// DAMAGE_IDLE_DESPAWN mob) so the prologue collect-then-drop loop fires; schedules
// three delayed events (due+fires, due+guard-fails-and-drops, future+stays-pending)
// so emitDueDelayedEvents exercises every branch; then kills the player and releases
// the spirit to the zone graveyard (full hp, auras + ccDr cleared, out of combat).
function entityRoster(): Scenario {
  return {
    name: 'entity_roster',
    coverage: [
      'addEntity roster + spatial grids',
      'despawn prologue: despawnTimer + DAMAGE_IDLE_DESPAWN idle-despawn (collect-then-drop)',
      'emitDueDelayedEvents drain (fires / guard-drops / stays-pending)',
      'releaseSpirit outdoor graveyard respawn (full hp, ~10966)',
    ],
    sampleEvery: 2,
    build: () => new Sim({ seed: 1012, playerClass: 'warrior', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(10);
      const p = sim.player as AnyEntity;
      beef(p);
      // (1a) despawnTimer churn: a far, quiescent mob set to expire in ~2 ticks.
      const ghost = spawnMob(sim, 'forest_wolf', 2, p.pos.x + 200, p.pos.y, p.pos.z + 200);
      ghost.hostile = false;
      ghost.despawnTimer = 0.1;
      rec.track(ghost.id);
      // (1b) idle-despawn churn: a DAMAGE_IDLE_DESPAWN mob, idle + out of combat,
      // with its idle timer pre-seeded so the second despawn branch fires.
      const guard = spawnMob(sim, 'varkas_boneguard', 30, p.pos.x - 200, p.pos.y, p.pos.z - 200);
      guard.hostile = false;
      guard.inCombat = false;
      guard.damageIdleDespawnTimer = 0.1;
      rec.track(guard.id);
      rec.notes.ghostId = ghost.id;
      rec.notes.guardId = guard.id;
      // (2) delayed-event drain: one due+fires, one due+guard-false (dropped), one
      // future (stays pending). delayedEvents is the field this slice owns.
      const delayed = (sim as any).delayedEvents as { at: number; event: any; guard?: () => boolean }[];
      delayed.push({ at: sim.time + 0.05, event: { type: 'respawn', pid: p.id } });
      delayed.push({ at: sim.time + 0.05, event: { type: 'respawn', pid: p.id }, guard: () => false });
      delayed.push({ at: sim.time + 100, event: { type: 'respawn', pid: p.id } });
      rec.tick(5); // both mobs despawn (0.1s) and the due delayed events resolve
      rec.snapshot('post-churn');
      // (4) outdoor release-spirit -> zone graveyard at FULL hp.
      p.hp = 1;
      p.dead = true;
      sim.releaseSpirit();
      rec.snapshot('graveyard-release');
      rec.tick(2);
    },
  };
}

// Delve player death (E1, merged E2): the in-delve release-spirit path. First death
// respawns at the module entry at 50% hp; a second death in the same run fails the
// run (no respawn) and ejects to the board door.
function delveDeath(): Scenario {
  return {
    name: 'delve_death',
    coverage: [
      'releaseSpiritInDelve first death (50% hp respawn at module entry, ~16345)',
      'releaseSpiritInDelve second death fails the run (deathsThisRun >= 2)',
      'rebucket after delve respawn teleport',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1013, playerClass: 'rogue', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const def = DELVES.collapsed_reliquary;
      sim.setPlayerLevel(def.minLevel);
      const p = sim.player as AnyEntity;
      beef(p);
      teleport(sim, p, def.doorPos.x, def.doorPos.z);
      sim.enterDelve('collapsed_reliquary', 'normal');
      const run = sim.delveRunForPlayer(sim.playerId);
      if (!run) {
        rec.tick(2);
        return;
      }
      run.bountiful = false; // pin against the rare coffer roll
      run.modules = ['reliquary_finale'];
      run.moduleIndex = 0;
      (sim as any).spawnDelveModule(run);
      // First death: 50% hp respawn at the module entry.
      p.dead = true;
      sim.releaseSpirit();
      rec.snapshot('delve-first-release');
      // Second death in the same run: fails the run (delveFailed, ejected).
      const e2 = sim.entities.get(sim.playerId) as AnyEntity;
      e2.dead = true;
      sim.releaseSpirit();
      rec.tick(2); // failDelveRun's delveFailed is queued, drained on the next tick
      rec.snapshot('delve-fail');
    },
  };
}

// C1 damage core: kill a player who is mid-cast inside a fiesta. Pins the
// dealDamage cross-team lethal arm's emit-THEN-fiestaTakedown order, plus the
// mid-cast interaction both ways: a non-lethal hit on a normal cast pushes the cast
// back (pushbackCast ~5664) and a non-lethal hit on the fishing cast cancels it
// (cancelCast ~5663). Mirrors the fiesta matchmaking flow so the match reaches
// active before the takedown.
function fiestaMidcastKill(): Scenario {
  return {
    name: 'fiesta_midcast_kill',
    coverage: [
      'dealDamage fiesta mid-cast pushback (pushbackCast ~5664)',
      'dealDamage fiesta mid-cast fishing-cancel (cancelCast ~5663)',
      'dealDamage fiesta cross-team takedown emit-then-fiestaTakedown order (~5512-5525)',
      'fiesta lifesteal augment arm (~5499)',
      'multi-player fiesta meta',
    ],
    sampleEvery: 25,
    build: () => new Sim({ seed: 1014, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const classes: Array<'warrior' | 'mage' | 'rogue' | 'hunter'> = ['warrior', 'mage', 'rogue', 'hunter'];
      const pids = classes.map((c, i) => sim.addPlayer(c, `F${i}`));
      pids.forEach((pid, i) => teleport(sim, sim.entities.get(pid)!, i * 4, -40));
      pids.forEach((pid) => sim.arenaQueueJoin(pid, 'fiesta'));
      rec.tick(1);
      for (let i = 0; i < 20 * 10; i++) {
        rec.tick(1);
        const m = sim.arenaMatchFor(pids[0]);
        if (m && m.state === 'active') break;
      }
      const match = sim.arenaMatchFor(pids[0]);
      if (match && match.fiesta && match.teamA.length && match.teamB.length) {
        const killer = sim.entities.get(match.teamA[0]) as AnyEntity;
        const victim = sim.entities.get(match.teamB[0]) as AnyEntity;
        beef(victim, 5000); // survive the two non-lethal cast-interrupt hits
        // (a) mid-cast pushback: a normal (non-fishing) cast, hit non-lethally.
        victim.castingAbility = 'fireball';
        victim.castRemaining = 2;
        victim.castTotal = 2;
        victim.channeling = false;
        sim.dealDamage(killer, victim, 50, false, 'physical', null, 'hit');
        rec.snapshot('midcast-pushback');
        // (b) mid-cast fishing cancel: the fishing cast is cancelled, not pushed.
        victim.castingAbility = FISHING_CAST_ID;
        victim.castRemaining = 5;
        victim.channeling = false;
        sim.dealDamage(killer, victim, 50, false, 'physical', null, 'hit');
        rec.snapshot('midcast-fishcancel');
        // (c) lethal cross-team hit: hp=0 -> emit damage -> fiestaTakedown -> return.
        victim.castingAbility = 'fireball';
        victim.castRemaining = 2;
        victim.castTotal = 2;
        victim.channeling = false;
        sim.dealDamage(killer, victim, victim.maxHp + 50, false, 'physical', null, 'hit');
        rec.notes.fiestaVictimPid = victim.id;
        rec.notes.fiestaKillerPid = killer.id;
        rec.snapshot('takedown');
        rec.tick(1);
      }
      rec.tick(20 * 2);
    },
  };
}

// C1 damage core: multiple classes wound a frenzyOnHit mob so maybeFrenzyOnHit (the
// ONLY rng draw in this slice) fires once per qualifying hit, pinning that draw at
// its global stream position. The frenzy chance is forced to 1 (the draw still
// happens; it just makes the blood_frenzy buff land deterministically so the push +
// refresh branches both run) and restored afterward (MOBS is a process-wide
// singleton). dealDamage is called directly per class source.
function multiClassFrenzy(): Scenario {
  return {
    name: 'multi_class_frenzy',
    coverage: [
      'dealDamage -> maybeFrenzyOnHit rng draw (the only in-slice draw, ~5651/5702)',
      'blood_frenzy push then refresh branches',
      'amp stack + threat handoff + tap rights across multiple attackers',
      'multi-class sources: warrior/mage/rogue',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1015, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const classes: Array<'warrior' | 'mage' | 'rogue'> = ['warrior', 'mage', 'rogue'];
      const pids = classes.map((c, i) => sim.addPlayer(c, `M${i}`));
      pids.forEach((pid, i) => {
        const e = sim.entities.get(pid) as AnyEntity;
        teleport(sim, e, i * 2, -30);
        beef(e); // keep every attacker alive while the mob swings back
      });
      const lead = sim.entities.get(pids[0]) as AnyEntity;
      const greyjaw = spawnMob(sim, 'old_greyjaw', 6, lead.pos.x + 1, lead.pos.y, lead.pos.z + 2);
      beef(greyjaw, 200000);
      greyjaw.hostile = true;
      rec.track(greyjaw.id);
      rec.notes.greyjawId = greyjaw.id;

      const greyTrait = MOBS.old_greyjaw.frenzyOnHit;
      const greyOrig = greyTrait ? greyTrait.chance : undefined;
      try {
        if (greyTrait) greyTrait.chance = 1;
        for (let round = 0; round < 4; round++) {
          for (const pid of pids) {
            const e = sim.entities.get(pid) as AnyEntity;
            sim.dealDamage(e, greyjaw, 30, false, 'physical', null, 'hit');
          }
          rec.snapshot(`frenzy-round-${round}`);
        }
      } finally {
        if (greyTrait && greyOrig !== undefined) greyTrait.chance = greyOrig;
      }
      rec.tick(10);
    },
  };
}

// C2 heal core: a healer of every class that owns a heal (priest/paladin/druid/
// shaman) heals a damaged tank while three hostile mobs hold threat on it, so BOTH
// the heal math (crit branch via the rng.chance(spellCrit) draw, overheal clamp,
// Weakening-Hex outgoing cut, Mortal-Wound incoming cut, heal-absorb soak with the
// depleted/survived split) AND the healingThreat fan-out (split evenly across the
// aware mobs, including the pet-owner threat-entry branch) land in the sampled
// trace. The four direct applyHeal calls are the verbatim heal core; the closing
// druid HoT exercises the aura-tick foreign callers (healingTakenMult + healingThreat
// off the `hot` branch), and a forced crit on a critvuln+hexed target exercises the
// dealDamage consumers of critVulnBonus/hexOutputMult. Forced crits boost the source's
// int so rng.chance(spellCrit) is certain to pass (the draw STILL fires, so the
// draw-order log stays meaningful); int is restored immediately. The existing four
// solo/mob scenarios never build a heal or a healing-threat table (parity CLAUDE.md
// "Known coverage gaps"), so this is the only scenario that pins heal drift.
function aura(spec: {
  id: string;
  name: string;
  kind: Aura['kind'];
  value: number;
  sourceId: number;
  duration?: number;
  tickInterval?: number;
}): Aura {
  const duration = spec.duration ?? 60;
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    remaining: duration,
    duration,
    value: spec.value,
    sourceId: spec.sourceId,
    school: 'physical',
    ...(spec.tickInterval !== undefined ? { tickInterval: spec.tickInterval } : {}),
  } as Aura;
}

function multiClassHeal(): Scenario {
  return {
    name: 'multi_class_heal',
    coverage: [
      'applyHeal core: crit branch (rng.chance(spellCrit) draw), overheal clamp, heal2 emit',
      'hexOutputMult outgoing cut (hex on source) + healingTakenMult Mortal-Wound cut (target)',
      'consumeHealAbsorb soak: small shield depletes+filters, big shield survives',
      'healingThreat even split across multiple aware mobs (entities.values insertion order)',
      'threatEntryMatchesEntity direct-target + pet-owner branches',
      'hot aura-tick heal path (healingTakenMult ~3089 + healingThreat ~3101)',
      'dealDamage consumers: critVulnBonus (crit-only) + hexOutputMult on a damage hit',
      'multi-class healers: priest/paladin/druid/shaman',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1016, playerClass: 'priest', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      // Four healers, each a class that owns a heal.
      const priest = sim.addPlayer('priest', 'Pr') as number;
      const paladin = sim.addPlayer('paladin', 'Pa') as number;
      const druid = sim.addPlayer('druid', 'Dr') as number;
      const shaman = sim.addPlayer('shaman', 'Sh') as number;
      const healerIds = [priest, paladin, druid, shaman];
      healerIds.forEach((pid, i) => teleport(sim, sim.entities.get(pid) as AnyEntity, i * 3, -30));
      const ePriest = sim.entities.get(priest) as AnyEntity;
      const ePaladin = sim.entities.get(paladin) as AnyEntity;
      const eDruid = sim.entities.get(druid) as AnyEntity;
      const eShaman = sim.entities.get(shaman) as AnyEntity;

      // The damaged friendly the healers heal (a player, so it is sampled by default).
      const tankPid = sim.addPlayer('warrior', 'Tk') as number;
      const tank = sim.entities.get(tankPid) as AnyEntity;
      teleport(sim, tank, 30, -30);
      beef(tank, 10000);

      // A pet owned by the tank, so a mob holding threat on the PET (not the tank
      // directly) still counts the tank as aware via threatEntryMatchesEntity's
      // owner branch. Friendly + no threat of its own, so it is never an aware mob.
      const pet = spawnMob(sim, 'forest_wolf', 5, 80, tank.pos.y, 80);
      pet.ownerId = tankPid;
      pet.hostile = false;
      pet.inCombat = false;

      // Three hostile mobs in combat on the tank, far enough that they do not engage
      // within the short HoT tick window. m1/m2 hold the tank directly; m3 holds the
      // tank's pet (the owner branch). Threat is seeded directly so the split is
      // deterministic and re-derivable for QA.
      const m1 = spawnMob(sim, 'forest_wolf', 5, 90, tank.pos.y, 90);
      const m2 = spawnMob(sim, 'forest_wolf', 5, -90, tank.pos.y, 90);
      const m3 = spawnMob(sim, 'forest_wolf', 5, 90, tank.pos.y, -90);
      for (const m of [m1, m2, m3]) {
        beef(m, 50000);
        m.hostile = true;
        m.inCombat = true;
        m.aiState = 'idle';
      }
      m1.threat.set(tankPid, 10);
      m2.threat.set(tankPid, 10);
      m3.threat.set(pet.id, 10); // owner branch: pet in m3's hate table
      rec.track(m1.id, m2.id, m3.id, pet.id);
      rec.notes.healerIds = healerIds;
      rec.notes.tankPid = tankPid;
      rec.notes.m1Id = m1.id;
      rec.notes.m2Id = m2.id;
      rec.notes.m3Id = m3.id;
      rec.notes.petId = pet.id;
      rec.notes.hotAbility = 'Rejuvenation';

      // Force a crit by boosting int so spellCrit(source) >= 1: rng.chance STILL
      // draws (next() < p), it just always passes, so the *1.5 crit path lands in
      // the golden deterministically. Restored immediately after the heal.
      const forcedHeal = (
        e: AnyEntity,
        source: number,
        amount: number,
        ability: string,
      ): void => {
        const int0 = e.stats.int;
        e.stats.int = 5000;
        (sim as any).applyHeal(sim.entities.get(source) as AnyEntity, tank, amount, ability);
        e.stats.int = int0;
      };

      // Heal 1: priest, plain (no mults), tank damaged -> split across all 3 mobs.
      tank.hp = 2000;
      (sim as any).applyHeal(ePriest, tank, 600, 'Heal');

      // Heal 2: paladin, forced crit (no mults) -> *1.5 path.
      tank.hp = 2000;
      forcedHeal(ePaladin, paladin, 800, 'Holy Light');

      // Heal 3: druid, hex on source (outgoing cut) + Mortal-Wound on target
      // (incoming cut), forced crit -> crit*hex*mortal combined.
      eDruid.auras.push(aura({ id: 'hex_dr', name: 'Weakening Hex', kind: 'hex', value: 0.3, sourceId: m1.id }));
      tank.auras.push(aura({ id: 'mw_tk', name: 'Mortal Wound', kind: 'mortal_wound', value: 0.5, sourceId: m1.id }));
      tank.hp = 2000;
      forcedHeal(eDruid, druid, 1000, 'Healing Touch');
      tank.auras = tank.auras.filter((a: Aura) => a.kind !== 'mortal_wound');

      // Heal 4: shaman, two heal-absorb shields -> the small one depletes and is
      // filtered out, the big one survives with reduced budget.
      tank.auras.push(aura({ id: 'absorb_small', name: 'Necrotic', kind: 'heal_absorb', value: 200, sourceId: m1.id }));
      tank.auras.push(aura({ id: 'absorb_big', name: 'Necrotic', kind: 'heal_absorb', value: 5000, sourceId: m1.id }));
      tank.hp = 2000;
      (sim as any).applyHeal(eShaman, tank, 1000, 'Healing Wave');

      // Heal 5: overheal -> healed clamps to 0 -> healingThreat healed<=0 early bail.
      tank.hp = tank.maxHp;
      (sim as any).applyHeal(ePriest, tank, 500, 'Heal');

      // Heal 6: aware.length===0 early bail (target with no mob holding threat on it).
      ePaladin.hp = Math.max(1, ePaladin.maxHp - 200);
      (sim as any).applyHeal(ePriest, ePaladin, 300, 'Heal');
      // One checkpoint pins the cumulative result of all six heals (per-heal amount +
      // crit are folded into this window's event digest; the draw-order log + tank/mob
      // threat tables are pinned in the frame body).
      rec.snapshot('heals');

      // dealDamage consumers: druid (still hexed) crit-hits a critvuln mob ->
      // hexOutputMult (outgoing-damage cut) + critVulnBonus (crit-only) both read.
      m1.auras.push(aura({ id: 'cv_m1', name: 'Find Weakness', kind: 'critvuln', value: 0.5, sourceId: druid }));
      sim.dealDamage(eDruid, m1, 100, true, 'physical', 'Smite', 'hit');
      rec.snapshot('crit-vuln-damage');

      // HoT path: a druid Rejuvenation on the tank ticks through the `hot` aura
      // branch -> healingTakenMult(~3089) + healingThreat(~3101) foreign callers.
      // (The surviving absorb_big rides along untouched: the hot branch never calls
      // consumeHealAbsorb, only applyHeal does.)
      tank.hp = 2000;
      tank.auras.push(
        aura({ id: 'hot_tk', name: 'Rejuvenation', kind: 'hot', value: 300, sourceId: druid, duration: 3, tickInterval: 0.1 }),
      );
      rec.tick(8); // ~4 HoT ticks; finish() pins the end state + folded HoT events
    },
  };
}

// C3 aura/regen runner: the per-tick aura/regen/timer slice that moves to
// src/sim/combat/auras.ts. Three phases pin the pieces other scenarios miss:
//  A. DoT-kills-mid-tick guard: a victim mob carries a buff at index 0 and a lethal
//     dot at index 1. updateAuras walks auras BACKWARD, so the dot ticks first; its
//     dealDamage drops the victim to dead and the `if (e.dead) return;` guard (~3095)
//     short-circuits BEFORE the index-0 aura is reached (handleDeath has already cleared
//     the corpse's auras, so without the guard the loop would walk a mutated list).
//     Reordering or dropping the guard forks the draw order / trace.
//  B. updateRegen eat/drink (the ctx.healingTakenMult seam call + the 'heal' emit) and
//     mana/hp regen, plus a short buff_ap that expires inside updateAuras -> statsDirty
//     -> recalcPlayerStats (player branch) + applyNonPlayerStatAura on expiry.
//  C. A ground AoE pulsing over 2+ hostiles so pulseGroundAoE iterates hostilesInRadius
//     and draws rng.range once per in-radius target in stable order (paladin_consecration
//     only ever has one mob in radius).
function c3AuraRunner(): Scenario {
  return {
    name: 'c3_aura_runner',
    coverage: [
      'updateAuras dot-tick kills target mid-walk -> e.dead guard short-circuits (~3095)',
      'updateAuras aura-expiry statsDirty -> recalcPlayerStats + applyNonPlayerStatAura',
      "updateRegen eat/drink path (ctx.healingTakenMult + 'heal' emit) + out-of-combat regen",
      'pulseGroundAoE over 2+ in-radius hostiles: rng.range per target, stable order',
      'class:paladin',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1017, playerClass: 'paladin', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(20); // consecration learnLevel 18
      const p = sim.player as AnyEntity;
      beef(p);

      // ----- Phase A: a DoT kills the victim mid-updateAuras (the e.dead guard) -----
      // The buff at index 0 + the lethal dot at index 1: the backward walk ticks the dot
      // first, its dealDamage kills the victim, and the guard returns before index 0 is
      // touched (the rider buff survives intact on the corpse). The dot is sourceless
      // (caster id absent) so the death cascade stays minimal and attributable.
      const ABSENT_SOURCE = 999999;
      const victim = spawnMob(sim, 'forest_wolf', 5, 40, p.pos.y, 40);
      victim.hostile = true;
      victim.auras.push(
        aura({ id: 'rider_buff', name: 'Rider', kind: 'buff_armor', value: 10, sourceId: ABSENT_SOURCE }),
      );
      victim.auras.push(
        aura({ id: 'lethal_dot', name: 'Rupture', kind: 'dot', value: 9999, sourceId: ABSENT_SOURCE, tickInterval: 0.05 }),
      );
      rec.track(victim.id);
      rec.notes.victimId = victim.id;
      rec.tick(2); // tick 1: dot ticks -> lethal -> guard fires; the index-0 buff survives
      rec.snapshot('dot-guard');

      // ----- Phase B: updateRegen eat/drink + an aura-expiry statsDirty recalc -----
      // Out of combat with hp/mana to recover, sitting to eat + drink. updateRegen fires
      // every 40 ticks (the 2s classic tick): the food heal runs ctx.healingTakenMult +
      // the 'heal' emit, the drink restores mana, and the short buff_ap expires inside
      // updateAuras -> statsDirty -> recalcPlayerStats (+ applyNonPlayerStatAura).
      p.inCombat = false;
      p.combatTimer = 99;
      p.fiveSecondRule = 99;
      p.hp = Math.max(1, p.maxHp - 600);
      p.resource = Math.max(0, p.maxResource - 300);
      p.eating = { itemId: 'parity_food', kind: 'food', hpPer2s: 90, manaPer2s: 0, remaining: 6 };
      p.drinking = { itemId: 'parity_drink', kind: 'drink', hpPer2s: 0, manaPer2s: 50, remaining: 6 };
      p.auras.push(aura({ id: 'short_buff', name: 'Blessing', kind: 'buff_ap', value: 20, sourceId: p.id, duration: 1.5 }));
      rec.tick(60); // >40: updateRegen fires (tick 40); buff_ap expires -> statsDirty recalc
      rec.snapshot('regen-expiry');

      // ----- Phase C: a ground AoE pulsing over 2+ hostiles -----
      // Two beefed mobs clustered inside consecration's 8yd radius so pulseGroundAoE
      // iterates hostilesInRadius (>=2 targets), drawing rng.range once per target in
      // entities-insertion order, from BOTH callers (the on-cast pulse + deferred ticks).
      const a1 = spawnMob(sim, 'forest_wolf', 5, p.pos.x + 2, p.pos.y, p.pos.z + 2);
      const a2 = spawnMob(sim, 'forest_wolf', 5, p.pos.x - 2, p.pos.y, p.pos.z - 2);
      for (const m of [a1, a2]) {
        beef(m, 40000);
        m.hostile = true;
      }
      rec.track(a1.id, a2.id);
      rec.notes.aoeMobIds = [a1.id, a2.id];
      p.resource = p.maxResource;
      p.gcdRemaining = 0;
      sim.castAbility('consecration'); // immediate on-cast pulse + deferred interval pulses
      rec.tick(20 * 6); // 6s of interval-2 deferred pulses over both mobs
    },
  };
}

// C4a casting lifecycle: drives the player cast lifecycle end to end across three
// caster classes plus a fishing cast, so the cast-start / updateCasting-progress /
// pushback / cancel / channel-tick / finish branches and their rng draws are all
// pinned in one trace. Forks no behavior off castAbility -> updateCasting; every
// interrupt rides the real dealDamage spell-pushback block (cancel vs pushback).
//  - mage fireball: timed-cast START (gcd arm) -> a mid-cast melee hit takes the
//    pushbackCast timed branch (+CAST_PUSHBACK_SEC) -> the cast FINISHES ->
//    applyAbility spell-hit roll (rng.chance(spellHitChance)) -> runEffects.
//  - priest lesser_heal (self): timed-cast START -> a silence aura lands ->
//    updateCasting's silence branch CANCELS it (cancelCast, castStop success:false).
//  - warlock drain_life: channel START (spend+arm at START) -> applyChannelTick
//    fires (drainTick rng.range draw + dealDamage + self-heal + healingThreat) ->
//    a mid-channel hit takes the pushbackCast channel-fraction branch.
//  - warlock fishing cast: a non-lethal hit CANCELS it (the FISHING_CAST_ID arm of
//    dealDamage's spell-pushback block -> cancelCast, not pushback).
function c4aCastingLifecycle(): Scenario {
  return {
    name: 'c4a_casting_lifecycle',
    coverage: [
      'castAbility timed-cast START (mage fireball) + Math.max gcd arm',
      'updateCasting progress + finish -> applyAbility spell-hit roll (rng) -> runEffects',
      'pushbackCast timed branch (+CAST_PUSHBACK_SEC) via dealDamage mid-cast',
      'updateCasting silence branch -> cancelCast (priest lesser_heal, holy)',
      'castAbility channel START (warlock drain_life): spend+arm at START',
      'applyChannelTick drainTick (rng.range draw + dealDamage + self-heal + healingThreat)',
      'pushbackCast channel-fraction branch via dealDamage mid-channel',
      'cancelCast fishing arm via dealDamage (FISHING_CAST_ID, not pushback)',
      'multi-class casters: mage/priest/warlock',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1017, playerClass: 'mage', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const mage = sim.addPlayer('mage', 'Mg') as number;
      const priest = sim.addPlayer('priest', 'Pr') as number;
      const warlock = sim.addPlayer('warlock', 'Wl') as number;
      const eMage = sim.entities.get(mage) as AnyEntity;
      const ePriest = sim.entities.get(priest) as AnyEntity;
      const eWarlock = sim.entities.get(warlock) as AnyEntity;
      // Level 12: fireball rank 3 (2.5s), lesser_heal rank 3 (2.0s, holy),
      // drain_life rank 1 (5s channel / 5 ticks = 1s per tick). drain_life needs >=10.
      for (const pid of [mage, priest, warlock]) sim.setPlayerLevel(12, pid);
      teleport(sim, eMage, -3, -45);
      teleport(sim, ePriest, 0, -45);
      teleport(sim, eWarlock, 3, -45);
      for (const e of [eMage, ePriest, eWarlock]) beef(e, 20000);

      // An idle (un-aggroed) hostile dummy the casters target; hostile=true so
      // isHostileTo passes, aiState idle so it does not retaliate mid-cast.
      const mob = spawnMob(sim, 'forest_wolf', 8, 0, eMage.pos.y, -40);
      beef(mob, 200000);
      mob.hostile = true;
      mob.aiState = 'idle';
      rec.track(mob.id);
      rec.notes.mageId = mage;
      rec.notes.priestId = priest;
      rec.notes.warlockId = warlock;
      rec.notes.mobId = mob.id;

      // --- mage: timed-cast start -> mid-cast pushback -> finish -> applyAbility ---
      eMage.resource = eMage.maxResource;
      face(eMage, mob);
      sim.targetEntity(mob.id, mage);
      sim.castAbility('fireball', mage); // timed-cast START (castStart)
      rec.tick(1); // updateCasting progress one tick
      sim.dealDamage(mob, eMage, 40, false, 'physical', null, 'hit'); // pushbackCast timed branch
      rec.snapshot('mage-pushback');
      rec.tick(120); // let the 2.5s cast (+ pushback) finish -> applyAbility -> runEffects

      // --- priest: timed self-heal start -> silence lands -> updateCasting cancel ---
      ePriest.hp = Math.max(1, ePriest.maxHp - 1000);
      ePriest.resource = ePriest.maxResource;
      sim.castAbility('lesser_heal', priest); // self (friendly fallback), timed START
      rec.tick(1); // progress one tick (no interrupt yet)
      ePriest.auras.push(
        aura({ id: 'c4a_silence', name: 'Silenced', kind: 'silence', value: 0, sourceId: mob.id, duration: 4 }),
      );
      rec.tick(1); // updateCasting silence branch -> cancelCast (castStop success:false)
      rec.snapshot('priest-silence-cancel');

      // --- warlock: channel start -> channel tick -> channel-fraction pushback ---
      eWarlock.hp = Math.max(1, eWarlock.maxHp - 500); // so the drain self-heal lands
      eWarlock.resource = eWarlock.maxResource;
      face(eWarlock, mob);
      sim.targetEntity(mob.id, warlock);
      sim.castAbility('drain_life', warlock); // channel START (spend+arm at START)
      rec.tick(22); // first channel tick fires at ~1s (20 ticks): applyChannelTick draws rng
      sim.dealDamage(mob, eWarlock, 40, false, 'physical', null, 'hit'); // pushbackCast channel branch
      rec.snapshot('warlock-channel-pushback');
      rec.tick(8);

      // --- warlock: a fishing cast cancelled by a hit (cancelCast fishing arm) ---
      eWarlock.castingAbility = FISHING_CAST_ID;
      eWarlock.castRemaining = 5;
      eWarlock.castTotal = 5;
      eWarlock.channeling = false;
      sim.dealDamage(mob, eWarlock, 20, false, 'physical', null, 'hit'); // cancelCast, not pushback
      rec.snapshot('warlock-fishing-cancel');
      rec.tick(5);
    },
  };
}

// C4b effect dispatch: a multi-class drive that fans runEffects across its most
// draw-order-sensitive cases in ONE golden so the move (runEffects -> combat/
// effect_dispatch.ts) is pinned. The highest-risk reorder points the brief calls
// out are each fired at least once, in effect-array order:
//  - warrior sunder_armor: the sunder MISS roll (rng.chance(meleeMissChance)).
//  - mage arcane_explosion: aoeDamage per-target rng.range over 2 in-radius mobs.
//  - rogue sinister_strike -> eviscerate -> kidney_shot: weaponStrike awardCombo
//    latch, finisherDamage range-THEN-chance, and the combo-spend reset after the loop.
//  - paladin seal_of_righteousness -> judgement -> consecration: imbue Seal, the
//    judgement range-THEN-chance draw (consuming the Seal), and the groundAoE on-cast
//    pulse (pulseGroundAoE + groundAoEs.push).
//  - druid moonfire -> bear_form -> cat_form -> rejuvenation: directDamage range-then-
//    chance + a dot in ONE cast, exclusive selfBuff form switch (recalc), and a hot.
//  - warlock fear -> summon_imp: incapacitate fear-angle draw rng.range(-PI,PI) and the
//    summonDemon -> ctx.summonPet path. Run FIRST (clean cast environment) so the timed
//    casts are not pushed back by another caster's ground-AoE.
function c4bEffectDispatch(): Scenario {
  return {
    name: 'c4b_effect_dispatch',
    coverage: [
      'runEffects multi-class multi-effect dispatch',
      'directDamage/finisherDamage range-then-chance (druid moonfire, rogue eviscerate)',
      'judgement range-then-chance (paladin seal -> judgement)',
      'incapacitate fear-angle draw rng.range(-PI,PI) (warlock fear)',
      'aoeDamage per-target rng.range (mage arcane_explosion, 2 mobs)',
      'sunder miss rng.chance (warrior sunder_armor)',
      'groundAoE on-cast pulse (paladin consecration)',
      'summonDemon -> summonPet (warlock summon_imp) + selfBuff form switch (druid)',
      'weaponStrike awardCombo latch + finisher combo-spend reset',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1018, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const warrior = sim.addPlayer('warrior', 'Wr') as number;
      const mage = sim.addPlayer('mage', 'Mg') as number;
      const rogue = sim.addPlayer('rogue', 'Rg') as number;
      const paladin = sim.addPlayer('paladin', 'Pl') as number;
      const druid = sim.addPlayer('druid', 'Dr') as number;
      const warlock = sim.addPlayer('warlock', 'Wl') as number;
      const eWarrior = sim.entities.get(warrior) as AnyEntity;
      const eMage = sim.entities.get(mage) as AnyEntity;
      const eRogue = sim.entities.get(rogue) as AnyEntity;
      const ePaladin = sim.entities.get(paladin) as AnyEntity;
      const eDruid = sim.entities.get(druid) as AnyEntity;
      const eWarlock = sim.entities.get(warlock) as AnyEntity;
      const cells: Array<[number, AnyEntity]> = [
        [-42, eWarrior],
        [-28, eMage],
        [-14, eRogue],
        [0, ePaladin],
        [14, eDruid],
        [42, eWarlock],
      ];
      for (const pid of [warrior, mage, rogue, paladin, druid, warlock]) sim.setPlayerLevel(20, pid);
      for (const [x, e] of cells) {
        teleport(sim, e, x, -45);
        beef(e, 50000);
      }
      rec.notes.warriorId = warrior;
      rec.notes.mageId = mage;
      rec.notes.rogueId = rogue;
      rec.notes.paladinId = paladin;
      rec.notes.druidId = druid;
      rec.notes.warlockId = warlock;

      // Spawn an idle hostile dummy adjacent to a caster (north, within melee).
      const dummy = (owner: AnyEntity, level = 8): AnyEntity => {
        const m = spawnMob(sim, 'forest_wolf', level, owner.pos.x, owner.pos.y, owner.pos.z + 3);
        beef(m, 500000);
        m.hostile = true;
        m.aiState = 'idle';
        rec.track(m.id);
        return m;
      };
      const ready = (e: AnyEntity): void => {
        e.gcdRemaining = 0;
        e.resource = e.maxResource;
      };

      // --- warlock FIRST (timed casts in a clean environment) ---
      const mobL = dummy(eWarlock);
      rec.notes.warlockMobId = mobL.id;
      face(eWarlock, mobL);
      sim.targetEntity(mobL.id, warlock);
      ready(eWarlock);
      sim.castAbility('fear', warlock); // 1.5s cast -> incapacitate fear-angle rng.range(-PI,PI)
      rec.tick(32); // finish fear
      rec.snapshot('warlock-fear');
      ready(eWarlock);
      sim.castAbility('summon_imp', warlock); // 5s cast -> summonDemon -> ctx.summonPet
      rec.tick(101); // finish summon
      rec.snapshot('warlock-summon');

      // --- warrior: sunder_armor (sunder miss rng.chance + threat) ---
      const mobW = dummy(eWarrior);
      face(eWarrior, mobW);
      sim.targetEntity(mobW.id, warrior);
      ready(eWarrior);
      sim.castAbility('sunder_armor', warrior);
      rec.snapshot('warrior-sunder');

      // --- mage: arcane_explosion (aoeDamage per-target rng.range over 2 mobs) ---
      const mobM1 = spawnMob(sim, 'forest_wolf', 8, eMage.pos.x + 2, eMage.pos.y, eMage.pos.z + 1);
      const mobM2 = spawnMob(sim, 'forest_wolf', 8, eMage.pos.x - 2, eMage.pos.y, eMage.pos.z + 2);
      for (const m of [mobM1, mobM2]) {
        beef(m, 500000);
        m.hostile = true;
        m.aiState = 'idle';
        rec.track(m.id);
      }
      rec.notes.aoeMobIds = [mobM1.id, mobM2.id];
      ready(eMage);
      sim.castAbility('arcane_explosion', mage);
      rec.snapshot('mage-arcane-explosion');

      // --- rogue: sinister_strike (weaponStrike awardCombo) then finishers ---
      const mobR = dummy(eRogue);
      face(eRogue, mobR);
      sim.targetEntity(mobR.id, rogue);
      ready(eRogue);
      sim.castAbility('sinister_strike', rogue); // weaponStrike -> meleeSwing + awardCombo latch
      ready(eRogue);
      eRogue.comboPoints = 3;
      eRogue.comboTargetId = mobR.id;
      sim.castAbility('eviscerate', rogue); // finisherDamage range-then-chance + combo reset
      ready(eRogue);
      eRogue.comboPoints = 2;
      eRogue.comboTargetId = mobR.id;
      sim.castAbility('kidney_shot', rogue); // finisherStun + combo-spend reset
      rec.snapshot('rogue-combo-finishers');

      // --- paladin: seal -> judgement (range-then-chance) -> consecration (groundAoE) ---
      const mobP = dummy(ePaladin);
      face(ePaladin, mobP);
      sim.targetEntity(mobP.id, paladin);
      ready(ePaladin);
      sim.castAbility('seal_of_righteousness', paladin); // imbue (sets the Seal)
      ready(ePaladin);
      sim.castAbility('judgement', paladin); // judgement: rng.range then rng.chance
      ready(ePaladin);
      sim.castAbility('consecration', paladin); // groundAoE: on-cast pulse + groundAoEs.push
      rec.snapshot('paladin-judge-consecrate');

      // --- druid: moonfire (directDamage range-then-chance + dot) -> forms -> hot ---
      const mobD = dummy(eDruid);
      face(eDruid, mobD);
      sim.targetEntity(mobD.id, druid);
      ready(eDruid);
      sim.castAbility('moonfire', druid); // directDamage (range then chance) + dot
      ready(eDruid);
      sim.castAbility('bear_form', druid); // selfBuff form + recalc
      ready(eDruid);
      sim.castAbility('cat_form', druid); // form switch (exclusive: strips bear)
      ready(eDruid);
      eDruid.hp = Math.max(1, eDruid.maxHp - 1000);
      sim.targetEntity(druid, druid); // self-target the friendly hot
      sim.castAbility('rejuvenation', druid); // hot
      rec.snapshot('druid-moonfire-forms');
    },
  };
}

// Player auto-attack + the melee/ranged white-hit table (C5). Drives the
// updatePlayerAutoAttack tick driver across several swing intervals for five
// builds at once: a warrior meleeing a spiked-hide boar (thorns reflect tail) with
// Heroic Strike queued (queuedOnSwing spend + bonus, cooldown 0), a rogue plain
// melee, a hunter in melee with Raptor Strike queued (queuedOnSwing + on-next-swing
// cooldown set, cd 6), a hunter at range firing Auto Shot (physical, armor-mitigated,
// 8yd dead zone), and a mage wanding (arcane, no armor, no dead zone). Targets are
// re-pinned to their lane each round so the ranged dead-zone vs wand branches stay
// exercised, and the rogue's auto-attack is stopped at the end (stopAutoAttack entry).
function c5AutoAttack(): Scenario {
  return {
    name: 'c5_auto_attack',
    coverage: [
      'player auto-attack driver updatePlayerAutoAttack (swingTimer cadence, facing/range gates)',
      'meleeSwing white-hit table: single rng.next() miss/dodge + crit + armor mitigation',
      'queuedOnSwing heroic_strike spend + bonus (warrior, cooldown 0)',
      'queuedOnSwing raptor_strike spend + bonus + on-next-swing cooldown set (hunter, cooldown 6)',
      'overpowerUntil window set on a melee dodge',
      'spiked-hide reflect tail of meleeSwing (wild_boar Bristled Hide)',
      'rangedSwing Auto Shot (hunter, physical, armor-mitigated, 8yd dead zone)',
      'rangedSwing Wand (mage, arcane, no armor, no dead zone)',
      'stopAutoAttack public entry',
    ],
    sampleEvery: 5,
    build: () => new Sim({ seed: 1019, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const warrior = sim.addPlayer('warrior', 'Wr') as number;
      const rogue = sim.addPlayer('rogue', 'Rg') as number;
      const hunterM = sim.addPlayer('hunter', 'Hm') as number;
      const hunterR = sim.addPlayer('hunter', 'Hr') as number;
      const mage = sim.addPlayer('mage', 'Mg') as number;
      const ids = [warrior, rogue, hunterM, hunterR, mage];
      for (const pid of ids) sim.setPlayerLevel(15, pid);
      const eWarrior = sim.entities.get(warrior) as AnyEntity;
      const eRogue = sim.entities.get(rogue) as AnyEntity;
      const eHunterM = sim.entities.get(hunterM) as AnyEntity;
      const eHunterR = sim.entities.get(hunterR) as AnyEntity;
      const eMage = sim.entities.get(mage) as AnyEntity;
      const lanes: Array<[AnyEntity, number]> = [
        [eWarrior, -60],
        [eRogue, -30],
        [eHunterM, 0],
        [eHunterR, 30],
        [eMage, 60],
      ];
      for (const [e, x] of lanes) {
        teleport(sim, e, x, -45);
        beef(e, 80000);
      }

      const spawnTarget = (owner: AnyEntity, key: string, dz: number, level: number): AnyEntity => {
        const m = spawnMob(sim, key, level, owner.pos.x, owner.pos.y, owner.pos.z + dz);
        beef(m, 500000);
        m.hostile = true;
        m.aiState = 'idle';
        rec.track(m.id);
        return m;
      };
      // dz 1.5 = melee; dz 20 = hunter Auto Shot band (> 8yd dead zone, <= 35);
      // dz 15 = wand band (no dead zone). wild_boar carries the spiked-hide thorns.
      const mobWarrior = spawnTarget(eWarrior, 'wild_boar', 1.5, 3);
      const mobRogue = spawnTarget(eRogue, 'forest_wolf', 1.5, 6);
      const mobHunterM = spawnTarget(eHunterM, 'forest_wolf', 1.5, 6);
      const mobHunterR = spawnTarget(eHunterR, 'forest_wolf', 20, 8);
      const mobMage = spawnTarget(eMage, 'forest_wolf', 15, 8);
      const pairs: Array<[number, AnyEntity, AnyEntity, number]> = [
        [warrior, eWarrior, mobWarrior, 1.5],
        [rogue, eRogue, mobRogue, 1.5],
        [hunterM, eHunterM, mobHunterM, 1.5],
        [hunterR, eHunterR, mobHunterR, 20],
        [mage, eMage, mobMage, 15],
      ];
      for (const [pid, e, m] of pairs) {
        face(e, m);
        sim.targetEntity(m.id, pid);
      }
      for (const pid of ids) sim.startAutoAttack(pid);

      for (let round = 0; round < 12; round++) {
        // Re-pin each target to its lane distance + re-face so the ranged dead-zone
        // (Auto Shot) vs no-dead-zone (Wand) branches stay deterministically exercised.
        for (const [, e, m, dz] of pairs) {
          teleport(sim, m, e.pos.x, e.pos.z + dz);
          face(e, m);
        }
        eWarrior.resource = eWarrior.maxResource;
        eHunterM.resource = eHunterM.maxResource;
        // Queue on-next-swing abilities (the guard avoids the cast-toggle that a
        // re-cast while already queued would trigger).
        if (eWarrior.gcdRemaining <= 0 && !eWarrior.castingAbility && !eWarrior.queuedOnSwing) {
          sim.castAbility('heroic_strike', warrior);
        }
        if (eHunterM.gcdRemaining <= 0 && !eHunterM.castingAbility && !eHunterM.queuedOnSwing) {
          sim.castAbility('raptor_strike', hunterM);
        }
        rec.tick(10);
      }
      rec.snapshot('swings');
      sim.stopAutoAttack(rogue); // public stop entry
      rec.tick(6);
      rec.snapshot('after-stop');
    },
  };
}

export const SCENARIOS: Scenario[] = [
  soloWarrior(),
  soloMage(),
  soloRogue(),
  affixMob(),
  hunterPet(),
  warlockPet(),
  paladinConsecration(),
  arena1v1(),
  fiesta(),
  delveLockpick(),
  partyLoot(),
  entityRoster(),
  delveDeath(),
  fiestaMidcastKill(),
  multiClassFrenzy(),
  multiClassHeal(),
  c3AuraRunner(),
  c4aCastingLifecycle(),
  c4bEffectDispatch(),
  c5AutoAttack(),
];
