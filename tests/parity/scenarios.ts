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

import { MOBS, DELVES, QUESTS } from '../../src/sim/data';
import { createMob } from '../../src/sim/entity';
import { Sim } from '../../src/sim/sim';
import { solveLockActions } from '../../src/sim/lockpick';
import { DT, FISHING_CAST_ID, MAX_LEVEL, type Entity } from '../../src/sim/types';
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

// Quest kill-credit (Q1): accept a kill quest at its giver NPC (driving
// finalizeQuestAccept's onInventoryChangedForQuests), then slay the target mob one
// at a time so handleDeath's party-credit loop fires onMobKilledForQuests (counts++
// + questProgress) until checkQuestReady promotes active -> ready; finally turn the
// quest in at the NPC for its xp + copper. Pins the quest-credit trio's kill path and
// the promotion arm of checkQuestReady.
function questKillCredit(): Scenario {
  return {
    name: 'quest_kill_credit',
    coverage: [
      'onMobKilledForQuests kill credit via handleDeath party loop (~5925)',
      'checkQuestReady promotion (active -> ready)',
      'acceptQuest -> finalizeQuestAccept -> onInventoryChangedForQuests',
      'turnInQuest (xp + copper reward)',
    ],
    build: () => new Sim({ seed: 1014, playerClass: 'warrior', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(10);
      const p = sim.player as AnyEntity;
      beef(p);
      const quest = QUESTS.q_wolves;
      // Accept at the giver NPC (marshal_redbrook): exercises finalizeQuestAccept's
      // onInventoryChangedForQuests foreign call.
      const giver = [...sim.entities.values()].find(
        (e: AnyEntity) => e.kind === 'npc' && e.templateId === quest.giverNpcId,
      ) as AnyEntity | undefined;
      if (giver) teleport(sim, p, giver.pos.x, giver.pos.z);
      sim.acceptQuest('q_wolves', sim.playerId);
      rec.snapshot('quest-accepted');
      // Slay each Forest Wolf one at a time (only one alive, so frenzyPackmates finds
      // no living packmate), crediting the player on every death.
      const need = quest.objectives[0].count; // 8
      for (let i = 0; i < need; i++) {
        const wolf = spawnMob(sim, 'forest_wolf', 2, p.pos.x + 2, p.pos.y, p.pos.z);
        wolf.tappedById = p.id;
        lethal(sim, p, wolf);
        rec.tick(1); // flush the kill's credit events; sample progress
      }
      rec.snapshot('quest-ready');
      // Turn in at the NPC (giver is also the turn-in for q_wolves).
      if (giver) teleport(sim, p, giver.pos.x, giver.pos.z);
      sim.turnInQuest('q_wolves', sim.playerId);
      rec.snapshot('quest-turned-in');
      rec.tick(2);
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

// Mob target selection + threat switching (M1): the per-tick target picker and the
// threat-switch rules that decide which player a mob hits and when a taunt or
// pull-over forces a swap. Drives updateMobTarget through the 110% melee and 130%
// ranged pull-over branches (plus the strict-boundary no-switch), the forced-target/
// taunt branch and its forcedTargetTimer expiry, then retargetMob through both the
// highest-threat pick and the prune-to-evade path (which also exercises the two new
// Nythraxis-add seam callbacks via a non-add mob, where they no-op). One hostile mob
// and three players each hold different threat; the mob + players are tracked so
// aggroTargetId, the threat table, forcedTargetTimer/Id, and aiState are pinned every
// snapshot. The four methods draw no rng, so this scenario pins their STATE decisions
// (the surrounding mob-AI draw order is already pinned by affix_mob / the solo runs).
function mobTargeting(): Scenario {
  return {
    name: 'mob_targeting',
    coverage: [
      'updateMobTarget 110% melee pull-over (MELEE_SWITCH_MULT, inMelee MELEE_RANGE*1.2)',
      'updateMobTarget 130% ranged pull-over (RANGED_SWITCH_MULT) + strict-boundary no-switch',
      'forced-target/taunt branch + forcedTargetTimer -= DT expiry + forcedTargetId clear',
      'retargetMob highest-threat pick + prune-to-evade (highestThreatTarget delete-during-iterate)',
      'nythraxisAddFallbackTarget / scheduleNythraxisAddDespawnIfBossReset seam callbacks (non-add -> no-op)',
    ],
    sampleEvery: 2,
    build: () => new Sim({ seed: 1014, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const tankId = sim.addPlayer('warrior', 'Tank');
      const bruiserId = sim.addPlayer('rogue', 'Bruiser');
      const casterId = sim.addPlayer('mage', 'Caster');
      const tank = sim.entities.get(tankId) as AnyEntity;
      const bruiser = sim.entities.get(bruiserId) as AnyEntity;
      const caster = sim.entities.get(casterId) as AnyEntity;
      beef(tank);
      beef(bruiser);
      beef(caster);
      const mob = spawnMob(sim, 'forest_wolf', 5, 0, terrainHeight(0, 0, sim.cfg.seed), 0);
      beef(mob, 50000);
      mob.hostile = true;
      rec.track(mob.id, tankId, bruiserId, casterId);
      rec.notes.mobId = mob.id;
      rec.notes.tankId = tankId;
      rec.notes.bruiserId = bruiserId;
      rec.notes.casterId = casterId;
      // tank + bruiser inside MELEE_RANGE*1.2 (=6) of the mob; caster well outside.
      teleport(sim, tank, 2, 0);
      teleport(sim, bruiser, -2, 0);
      teleport(sim, caster, 0, 20);

      // Baseline: mob on the tank (highest threat); no one is over a switch threshold.
      mob.threat.set(tankId, 100);
      mob.threat.set(bruiserId, 50);
      mob.threat.set(casterId, 50);
      mob.aggroTargetId = tankId;
      mob.aiState = 'attack';
      mob.inCombat = true;
      (sim as any).updateMobTarget(mob);
      rec.snapshot('baseline-tank');

      // 110% melee pull-over: bruiser (in melee) crosses 110% of the tank's 100.
      mob.threat.set(bruiserId, 120);
      (sim as any).updateMobTarget(mob);
      rec.notes.afterMelee = mob.aggroTargetId;
      rec.snapshot('melee-pullover');

      // Ranged strict boundary: caster at EXACTLY 130% does NOT pull (strict `>`).
      mob.aggroTargetId = tankId;
      mob.threat.set(bruiserId, 50);
      mob.threat.set(casterId, 130);
      (sim as any).updateMobTarget(mob);
      rec.notes.afterRangedBoundary = mob.aggroTargetId;
      rec.snapshot('ranged-boundary-no-switch');

      // 130% ranged pull-over: caster (out of melee) crosses 130% of the tank's 100.
      mob.aggroTargetId = tankId;
      mob.threat.set(casterId, 140);
      (sim as any).updateMobTarget(mob);
      rec.notes.afterRanged = mob.aggroTargetId;
      rec.snapshot('ranged-pullover');

      // Forced-target/taunt branch: lock the mob onto the tank despite the caster's
      // higher threat. The branch decrements the timer and early-returns first.
      mob.aggroTargetId = casterId;
      mob.forcedTargetId = tankId;
      mob.forcedTargetTimer = 3;
      (sim as any).updateMobTarget(mob);
      rec.notes.afterTauntForced = mob.aggroTargetId;
      rec.snapshot('taunt-forced');

      // Timer about to expire: this call still honors the forced target (returns
      // before the clear), but the `-= DT` drives forcedTargetTimer negative.
      mob.forcedTargetTimer = DT / 2;
      (sim as any).updateMobTarget(mob);
      rec.snapshot('taunt-decrement');

      // Timer expired: forcedTargetId clears and the threat scan reclaims the caster.
      (sim as any).updateMobTarget(mob);
      rec.notes.afterTauntExpired = mob.aggroTargetId;
      rec.snapshot('taunt-expired');

      // retargetMob: with living threat it grabs the highest (caster) and chases.
      (sim as any).retargetMob(mob);
      rec.notes.afterRetarget = mob.aggroTargetId;
      rec.snapshot('retarget-highest');

      // retargetMob with only stale (missing-entity) threat: highestThreatTarget
      // prunes every entry mid-iterate -> no living target -> (non-add, so both
      // Nythraxis seam callbacks no-op) -> evade home with an empty threat table.
      mob.threat.clear();
      mob.threat.set(900001, 30);
      mob.threat.set(900002, 10);
      mob.aggroTargetId = casterId;
      mob.aiState = 'chase';
      (sim as any).retargetMob(mob);
      rec.notes.finalAiState = mob.aiState;
      rec.snapshot('retarget-evade');
    },
  };
}

// Quest collect-credit + turn-in (Q1): accept a collect quest at its NPC, gather the
// objective item one at a time so each addItem drives onInventoryChangedForQuests
// (counts++ + questProgress) until checkQuestReady promotes active -> ready; then drop
// one item so removeItem demotes ready -> active (the demotion arm), re-collect it, and
// finally turn the quest in (turnInQuest's removeItem re-fires onInventoryChangedForQuests
// before granting xp + copper). Pins the collect path and BOTH arms of checkQuestReady.
function questCollectTurnIn(): Scenario {
  return {
    name: 'quest_collect_turnin',
    coverage: [
      'onInventoryChangedForQuests via addItem/removeItem inventory hub (~9782/9800)',
      'checkQuestReady promotion AND demotion (ready <-> active)',
      'acceptQuest -> finalizeQuestAccept -> onInventoryChangedForQuests',
      'turnInQuest -> removeItem -> onInventoryChangedForQuests (xp + copper)',
    ],
    build: () => new Sim({ seed: 1015, playerClass: 'warrior', autoEquip: false }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const p = sim.player as AnyEntity;
      const quest = QUESTS.q_boars;
      const item = quest.objectives[0].itemId as string; // boar_hide
      const need = quest.objectives[0].count; // 5
      const npc = [...sim.entities.values()].find(
        (e: AnyEntity) => e.kind === 'npc' && e.templateId === quest.giverNpcId,
      ) as AnyEntity | undefined;
      if (npc) teleport(sim, p, npc.pos.x, npc.pos.z);
      sim.acceptQuest('q_boars', sim.playerId);
      rec.snapshot('quest-accepted');
      // Collect to completion, one hide at a time: each addItem drives the inventory
      // hub -> onInventoryChangedForQuests; the last one promotes the quest to ready.
      for (let i = 0; i < need; i++) {
        sim.addItem(item, 1, sim.playerId);
      }
      rec.snapshot('collect-ready');
      // Demotion arm: drop one hide -> onInventoryChangedForQuests recomputes have < count
      // -> checkQuestReady demotes ready -> active.
      sim.removeItem(item, 1, sim.playerId);
      rec.snapshot('collect-demoted');
      // Re-collect the dropped hide -> ready again.
      sim.addItem(item, 1, sim.playerId);
      rec.snapshot('collect-re-ready');
      // Turn in at the NPC: turnInQuest removes the collected items (re-firing
      // onInventoryChangedForQuests) then grants xp + copper.
      if (npc) teleport(sim, p, npc.pos.x, npc.pos.z);
      sim.turnInQuest('q_boars', sim.playerId);
      rec.snapshot('quest-turned-in');
      rec.tick(2);
    },
  };
}

// Party/raid state machine (A1): the full social flow, which draws NO rng of its
// own. Forms a party of five, converts it to a raid, fills to a second subgroup,
// moves a member across groups, then hands off leadership and drains the roster to
// a disband. Pins the party emit stream (invite + join/convert/move/leave/handoff/
// disband logs) in order; partyOf must keep resolving after the move. The draw-order
// digest must stay byte-identical (this slice never touches rng), so any drift means
// a surrounding draw shifted.
function partyRaid(): Scenario {
  return {
    name: 'party_raid',
    coverage: [
      'partyInvite/partyAccept party formation (~11864/11901)',
      'convertPartyToRaid full-party gate (RAID_MIN) + normalizeRaidGroups',
      'raid fill to two subgroups (nextRaidGroupFor) + moveRaidMember (RAID_GROUP_MAX)',
      'removeFromParty leadership handoff + disband + partyOf via SimContext',
    ],
    build: () => new Sim({ seed: 1014, playerClass: 'warrior', noPlayer: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      const a = sim.addPlayer('warrior', 'Aaa');
      const b = sim.addPlayer('mage', 'Bbb');
      const c = sim.addPlayer('rogue', 'Ccc');
      const d = sim.addPlayer('hunter', 'Ddd');
      const e = sim.addPlayer('warlock', 'Eee');
      const f = sim.addPlayer('paladin', 'Fff');
      const g = sim.addPlayer('warrior', 'Ggg');
      rec.track(a, b, c, d, e, f, g);
      // 1) a invites four; each accepts -> a full party of five.
      for (const m of [b, c, d, e]) {
        sim.partyInvite(m, a);
        sim.partyAccept(m);
      }
      rec.snapshot('party-of-5');
      // 2) convert the full party to a raid (requires RAID_MIN members).
      sim.convertPartyToRaid(a);
      rec.snapshot('raid');
      // 3) invite two more; subgroup 1 is full (5) so they land in subgroup 2.
      for (const m of [f, g]) {
        sim.partyInvite(m, a);
        sim.partyAccept(m);
      }
      rec.snapshot('raid-of-7');
      // 4) move a subgroup-1 member into subgroup 2.
      sim.moveRaidMember(b, 2, a);
      rec.snapshot('moved');
      // 5) the leader leaves -> leadership hands off to the first remaining member.
      sim.partyLeave(a);
      rec.snapshot('leader-left');
      // 6) drain the rest; the last departure triggers the disband branch.
      for (const m of [c, d, e, f, g]) sim.partyLeave(m);
      rec.snapshot('disband');
    },
  };
}

// Talent application (G1a): exercise every sim-side talent method (applyTalents /
// respec / saveLoadout + switchLoadout / setSpec) on a max-level warrior so the flat
// `talentMods` struct re-bakes and the known-ability list flips on each change. Drives
// NO rng (talent application is deterministic validation + struct baking), so the draw
// digest stays empty/byte-identical across the extraction. Pure snapshots, no ticks, so
// the player never enters combat and the talent-lock guard never trips.
function talentsProgression(): Scenario {
  return {
    name: 'talents_progression',
    coverage: [
      'applyTalents valid spec build (G1a) + recomputeTalents flat-struct bake',
      'respec wipes ranks, keeps spec',
      'saveLoadout (object-alloc overload) + switchLoadout (2 of 4 slots)',
      'setSpec drops the prior spec tree points',
      'refreshKnownAbilities(announce=false): known-ability list flips per change',
    ],
    sampleEvery: 2,
    build: () => new Sim({ seed: 1014, playerClass: 'warrior', autoEquip: true }),
    drive(rec: Recorder) {
      const sim = rec.sim as AnySim;
      sim.setPlayerLevel(MAX_LEVEL); // enough talent points for a spec'd build
      // (1) Apply a valid Arms build: the flat talentMods bakes + known list changes.
      sim.applyTalents({ spec: 'arms', ranks: { war_cruelty: 2, arms_imp_overpower: 2 }, choices: {} });
      rec.snapshot('apply-arms');
      // (2) Respec: ranks wiped, spec retained, stats revert.
      sim.respec();
      rec.snapshot('respec');
      // (3) Save the respec'd build as a loadout (the HUD positional-alloc overload),
      // apply a different build, then switch back to slot 0.
      sim.saveLoadout('Arms', ['mortal_strike', 'overpower', null], {
        spec: 'arms',
        ranks: { arms_imp_overpower: 2 },
        choices: {},
      });
      sim.applyTalents({ spec: 'arms', ranks: { war_cruelty: 3 }, choices: {} });
      rec.snapshot('second-build');
      sim.switchLoadout(0);
      rec.snapshot('switch-loadout');
      // (4) Set spec to Fury: the prior (Arms) spec tree's points drop; class points stay.
      sim.setSpec('fury');
      rec.snapshot('set-spec');
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
  partyRaid(),
  entityRoster(),
  delveDeath(),
  fiestaMidcastKill(),
  multiClassFrenzy(),
  mobTargeting(),
  questKillCredit(),
  questCollectTurnIn(),
  talentsProgression(),
];
