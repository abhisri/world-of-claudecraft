// SimContext: the shared seam every extracted game-system module talks to instead
// of reaching into the 17.5k-line `Sim` monolith.
//
// Session S0b DEFINES this seam and threads it through the tick path; it MOVES NO
// behavior. Every callback below ROUTES to a method that still lives on `Sim`
// (the "points-at = Sim" column of 02-WORKING-MEMORY.md's callback registry). As a
// later slice extracts an owner, it reimplements that callback inside its own module
// WITHOUT renaming it here, so consumers never change. Treat the surface as
// APPEND-ONLY: add callbacks, never repurpose or rename one.
//
// This module is `src/sim`-pure: it imports only sibling sim types (no render/ui/
// game/net/DOM/Three, no `Math.random`/`Date.now`), so it runs unchanged in Node,
// the browser, and the headless RL env (enforced by tests/architecture.test.ts).

import type { TalentModifiers } from './content/talents';
import type { DelayedEvent, GroundAoE } from './entity_roster';
import type { Rng } from './rng';
import type { ArenaMatch, DuelState, Party, PlayerMeta } from './sim';
import type { SpatialGrid } from './spatial';
import type { Aura, CrowdControlDrCategory, DelveRun, Entity, SimConfig, SimEvent, Vec3 } from './types';

// Live primitive views onto the running Sim. These are GETTERS, not snapshots:
// `time`/`tickCount` advance every tick, and the `rng`/`entities` identities are
// shared so a consumer observes the same mutable world the Sim does (the engine
// mutates entities in place under the refactor's immutability waiver).
export interface SimContextPrimitives {
  readonly rng: Rng;
  readonly time: number;
  readonly tickCount: number;
  readonly entities: Map<number, Entity>;
  // Spatial indexes kept roster-exact alongside `entities` (E1). Stay public on Sim
  // too (server/game.ts queries them); exposed here as live views for the roster ops.
  readonly grid: SpatialGrid;
  readonly playerGrid: SpatialGrid;
  // Sim-owned tick-prologue collections (E1). The drains (drainDelayedEvents /
  // tickGroundAoEs) live in entity_roster; the SCHEDULING push sites stay on Sim
  // (N1/M3 delayed events, C1/C4b ground AoEs), so the fields stay on Sim and are
  // reached here as live views. `delayedEvents` is read-write (the drain reassigns
  // the pending list); `groundAoEs` is mutated in place (splice), so read-only.
  delayedEvents: DelayedEvent[];
  readonly groundAoEs: GroundAoE[];
  // dungeon-door registry (I1) appended to on dungeon_door spawn; null until built.
  readonly dungeonDoorIds: number[] | null;
  // live arena bouts keyed by every participant pid (A2); release-spirit early-bails
  // when the dead player is mid-bout.
  readonly arenaMatches: Map<number, ArenaMatch>;
  // Player roster keyed by entity id (M2: the boss pulse/stomp/terrify arms iterate it).
  // Live view; the backing field stays on Sim. [DEDUPE with A1/C1, which also add it.]
  readonly players: Map<number, PlayerMeta>;
  // Resolved sim config (M2: mob movement reads cfg.seed for terrain height).
  // [DEDUPE with C1, which also adds it.]
  readonly cfg: Required<Omit<SimConfig, 'noPlayer'>>;
}

// Cross-system callbacks. Each signature mirrors the still-on-`Sim` method it
// currently delegates to, EXACTLY (arg order + types preserved), so a delegation is
// a faithful move-not-rewrite. Grouped by the slice that will eventually own them.
export interface SimContextCallbacks {
  // Event sink (core). Routes to `Sim.emit`.
  emit(ev: SimEvent): void;

  // C1 damage/death hub + the casting/leash/arena/duel/fiesta/loot teardown it
  // drives mid-tick. `dealDamage` is the post-mitigation entry (crit/dodge/miss and
  // armor are resolved upstream in meleeSwing/rangedSwing).
  dealDamage(
    source: Entity | null,
    target: Entity,
    amount: number,
    crit: boolean,
    school: string,
    ability: string | null,
    kind: 'hit' | 'miss' | 'dodge',
    noRage?: boolean,
    threatOpts?: { flat?: number; mult?: number },
  ): void;
  handleDeath(entity: Entity, killer: Entity | null): void;
  cancelCast(entity: Entity): void;
  pushbackCast(entity: Entity): void;
  refreshMobLeashFromAction(source: Entity | null, target: Entity): void;
  retargetMob(mob: Entity): void;
  // M1: Nythraxis boss-add target helpers that retargetMob consults (the extracted
  // mob/targeting module reaches them through the seam). Owned by the later
  // Nythraxis slice (N1); stay on Sim for now (findNythraxisBossForAdd bookkeeping).
  nythraxisAddFallbackTarget(add: Entity): Entity | null;
  scheduleNythraxisAddDespawnIfBossReset(add: Entity): boolean;
  isArenaCrossTeam(match: ArenaMatch, attackerPid: number, targetPid: number): boolean;
  arenaTeamOf(match: ArenaMatch, pid: number): 'A' | 'B' | null;
  endArenaMatch(
    match: ArenaMatch,
    winnerTeam: 'A' | 'B' | null,
    reason: 'defeat' | 'timeout' | 'forfeit',
  ): void;
  endDuel(duel: DuelState, winnerPid: number | null): void;
  fiestaTakedown(match: ArenaMatch, killerPid: number, victim: Entity): void;
  fiestaDown(match: ArenaMatch, victim: Entity, killerPid: number | null): void;
  rollLoot(mob: Entity, meta: PlayerMeta, eligible?: PlayerMeta[]): void;

  // C2/C3/C4b heal, aura, knockback, and crowd-control surface.
  applyHeal(source: Entity, target: Entity, amount: number, ability: string): void;
  applyAura(target: Entity, aura: Aura): void;
  applyRootAura(
    source: Entity,
    target: Entity,
    name: string,
    id: string,
    duration: number,
    school: Aura['school'],
  ): void;
  applyKnockback(source: Entity, target: Entity, distance: number): number;
  diminishedCrowdControlDuration(
    source: Entity,
    target: Entity,
    category: CrowdControlDrCategory,
    duration: number,
  ): number | null;
  hostilesInRadius(source: Entity, pos: Vec3, radius: number): Entity[];
  breakStealth(entity: Entity): void;

  // Shared entry point (stays on Sim, exposed here): taunt forces a mob's target.
  applyTaunt(target: Entity, mob: Entity): void;

  // P1 pet lifecycle.
  summonPet(owner: Entity, templateId: string): void;
  petOf(ownerPid: number, includeDead?: boolean): Entity | null;
  completeTame(player: Entity, target: Entity): void;

  // A1/T1 raid markers + party; Q1 quest credit on inventory change.
  clearEntityMarker(entityId: number): void;
  partyOf(pid: number): Party | null;
  removeFromParty(pid: number, verb: string): void;
  onInventoryChangedForQuests(meta: PlayerMeta): void;

  // E1 entity roster: the moved roster ops, exposed so the foreign callers across
  // not-yet-extracted slices reach them through the seam. Implemented in
  // entity_roster; Sim retains thin delegating methods so existing `this.addEntity`
  // / test `sim.addEntity` call sites resolve unchanged.
  addEntity(e: Entity): void;
  dropEntity(id: number): void;
  rebucket(e: Entity): void;

  // E1 forward references the moved code consumes; all still on Sim. `resolve`,
  // `groundPos`, `playerMods` are core; `delveRunForPlayer`/`delveModuleEntry`/
  // `failDelveRun` are delve-slice internals release-spirit calls; `pulseGroundAoE`
  // is the shared ground-AoE entry point the drain pulses.
  resolve(pid?: number): { meta: PlayerMeta; e: Entity } | null;
  groundPos(x: number, z: number): Vec3;
  playerMods(meta: PlayerMeta): TalentModifiers;
  delveRunForPlayer(pid: number): DelveRun | null;
  delveModuleEntry(run: DelveRun): Vec3;
  failDelveRun(run: DelveRun): void;
  pulseGroundAoE(effect: GroundAoE, threatOpts?: { flat?: number; mult?: number }): void;

  // M2 mob locomotion: the updateMob dispatcher reaches every boss/pet/Nythraxis/
  // corpse branch and movement helper it dispatches to through these. All still live
  // on Sim (or a shared module); the eventual owners flip points-at, never rename.
  // --- shared movement/combat entry points (STAY on Sim, exposed here) ---
  moveToward(e: Entity, dest: Vec3, speed: number, ignoreObstacles?: boolean): boolean;
  mobSwing(mob: Entity, target: Entity): void;
  updateRangedPetAttack(
    pet: Entity,
    target: Entity,
    spell: {
      name: string;
      school: 'physical' | 'fire' | 'frost' | 'arcane' | 'shadow' | 'holy' | 'nature';
      min: number;
      max: number;
      range: number;
      every: number;
    },
  ): void;
  fleeMoveSpeed(e: Entity): number;
  // --- mob-AI helpers the dispatcher consults ---
  usesProfiledMobCombat(mob: Entity): boolean;
  updateProfiledMobCombat(mob: Entity): void;
  tryMobMeleeSwingInRange(mob: Entity, target: Entity): boolean;
  maybeFlee(mob: Entity, target: Entity): boolean;
  aggroMob(mob: Entity, target: Entity, social: boolean): void;
  isStunned(e: Entity): boolean;
  isRooted(e: Entity): boolean;
  moveSpeedMult(e: Entity): number;
  swingIntervalMult(e: Entity): number;
  mobEffectiveMeleeRange(mob: Entity): number;
  mobCanSwim(template: { family?: string; canSwim?: boolean } | undefined): boolean;
  resolveMovePoint(nx: number, nz: number, r: number, e: Entity): { x: number; z: number };
  // --- pet / delve-companion / boss-mechanic branches (owners: P1 / delve / M3-N1) ---
  updatePet(pet: Entity): void;
  isDelveCompanionMob(mob: Entity): boolean;
  updateDelveCompanion(companion: Entity): void;
  updateBossMechanics(mob: Entity): void;
  updateNythraxisEncounter(boss: Entity): void;
  resetNythraxisEncounter(boss: Entity): void;
  despawnSummonedAdds(boss: Entity): void;
  updateFearMovement(e: Entity): boolean;
  delveDetectMult(player: Entity): number;
  // --- corpse lifecycle (mob/lifecycle.ts, M4; despawnPet is P1's pet slice) ---
  detonateCorpse(dead: Entity): void;
  despawnPet(pet: Entity): void;
  respawnMob(mob: Entity): void;
  frenzyPackmates(dead: Entity): void;
  armDeathThroes(dead: Entity): void;
  // shared helpers the M4 respawnMob body consumes; the bodies STAY on Sim (the pet
  // slice owns despawnPersistentPet eventually; clearNonPlayerStatAuras is shared).
  despawnPersistentPet(pet: Entity): void;
  clearNonPlayerStatAuras(target: Entity): void;
  // --- boss-death dialogue hook (N1 owns the body; left here by M2) ---
  onBossDeath(mob: Entity): void;

  // M3 mob on-hit affix cascade (mob/mob_swing): two stat helpers the cascade
  // reaches back for. Both STAY on Sim. `effectiveArmor` is the cleave-splash armor
  // read; `recalcPlayer` rebakes a player victim's derived stats after Devour Magic
  // strips a beneficial aura (wraps the Sim players-map lookup + recalcPlayerStats so
  // the module never touches the map directly).
  effectiveArmor(e: Entity): number;
  recalcPlayer(target: Entity): void;

  // P1a pet AI (src/sim/pet/pet_ai): the moved updatePet/petRangedAttack/petPickTarget
  // reach back for these. All STAY on Sim. `syncPetAspect` is pet-management (the P1b
  // pet-command slice owns it eventually); `effectiveAttackPower` scales the imp bolt;
  // `isHostileTo` is the shared hostility predicate (~20 other Sim callers keep this.).
  syncPetAspect(pet: Entity, owner: Entity): void;
  effectiveAttackPower(e: Entity): number;
  isHostileTo(attacker: Entity, target: Entity): boolean;
}

// The seam consumed by extracted modules.
export interface SimContext extends SimContextPrimitives, SimContextCallbacks {}

// What `Sim` supplies to build a SimContext. Structurally identical to SimContext
// today, but kept as its own name to make the data flow explicit (Sim -> host ->
// context) and to let the consumed seam narrow independently of the provider later.
export interface SimContextHost extends SimContextPrimitives, SimContextCallbacks {}

// Assemble the immutable SimContext from its host. The primitives stay LIVE (each
// access reads through to the host, so `time`/`tickCount` reflect the current tick
// and `rng`/`entities` are the shared instances); the callbacks pass through
// unchanged (the host already binds them to the Sim). Pure: this constructs no
// state, draws no rng, and reads no clock, so installing the seam cannot perturb
// determinism.
export function createSimContext(host: SimContextHost): SimContext {
  return {
    get rng() {
      return host.rng;
    },
    get time() {
      return host.time;
    },
    get tickCount() {
      return host.tickCount;
    },
    get entities() {
      return host.entities;
    },
    get grid() {
      return host.grid;
    },
    get playerGrid() {
      return host.playerGrid;
    },
    get delayedEvents() {
      return host.delayedEvents;
    },
    set delayedEvents(v) {
      host.delayedEvents = v;
    },
    get groundAoEs() {
      return host.groundAoEs;
    },
    get dungeonDoorIds() {
      return host.dungeonDoorIds;
    },
    get arenaMatches() {
      return host.arenaMatches;
    },
    get players() {
      return host.players;
    },
    get cfg() {
      return host.cfg;
    },
    emit: host.emit,
    dealDamage: host.dealDamage,
    handleDeath: host.handleDeath,
    cancelCast: host.cancelCast,
    pushbackCast: host.pushbackCast,
    refreshMobLeashFromAction: host.refreshMobLeashFromAction,
    retargetMob: host.retargetMob,
    nythraxisAddFallbackTarget: host.nythraxisAddFallbackTarget,
    scheduleNythraxisAddDespawnIfBossReset: host.scheduleNythraxisAddDespawnIfBossReset,
    isArenaCrossTeam: host.isArenaCrossTeam,
    arenaTeamOf: host.arenaTeamOf,
    endArenaMatch: host.endArenaMatch,
    endDuel: host.endDuel,
    fiestaTakedown: host.fiestaTakedown,
    fiestaDown: host.fiestaDown,
    rollLoot: host.rollLoot,
    applyHeal: host.applyHeal,
    applyAura: host.applyAura,
    applyRootAura: host.applyRootAura,
    applyKnockback: host.applyKnockback,
    diminishedCrowdControlDuration: host.diminishedCrowdControlDuration,
    hostilesInRadius: host.hostilesInRadius,
    breakStealth: host.breakStealth,
    applyTaunt: host.applyTaunt,
    summonPet: host.summonPet,
    petOf: host.petOf,
    completeTame: host.completeTame,
    clearEntityMarker: host.clearEntityMarker,
    partyOf: host.partyOf,
    removeFromParty: host.removeFromParty,
    onInventoryChangedForQuests: host.onInventoryChangedForQuests,
    addEntity: host.addEntity,
    dropEntity: host.dropEntity,
    rebucket: host.rebucket,
    resolve: host.resolve,
    groundPos: host.groundPos,
    playerMods: host.playerMods,
    delveRunForPlayer: host.delveRunForPlayer,
    delveModuleEntry: host.delveModuleEntry,
    failDelveRun: host.failDelveRun,
    pulseGroundAoE: host.pulseGroundAoE,
    // M2 mob locomotion seam.
    moveToward: host.moveToward,
    mobSwing: host.mobSwing,
    updateRangedPetAttack: host.updateRangedPetAttack,
    fleeMoveSpeed: host.fleeMoveSpeed,
    usesProfiledMobCombat: host.usesProfiledMobCombat,
    updateProfiledMobCombat: host.updateProfiledMobCombat,
    tryMobMeleeSwingInRange: host.tryMobMeleeSwingInRange,
    maybeFlee: host.maybeFlee,
    aggroMob: host.aggroMob,
    isStunned: host.isStunned,
    isRooted: host.isRooted,
    moveSpeedMult: host.moveSpeedMult,
    swingIntervalMult: host.swingIntervalMult,
    mobEffectiveMeleeRange: host.mobEffectiveMeleeRange,
    mobCanSwim: host.mobCanSwim,
    resolveMovePoint: host.resolveMovePoint,
    updatePet: host.updatePet,
    isDelveCompanionMob: host.isDelveCompanionMob,
    updateDelveCompanion: host.updateDelveCompanion,
    updateBossMechanics: host.updateBossMechanics,
    updateNythraxisEncounter: host.updateNythraxisEncounter,
    resetNythraxisEncounter: host.resetNythraxisEncounter,
    despawnSummonedAdds: host.despawnSummonedAdds,
    updateFearMovement: host.updateFearMovement,
    delveDetectMult: host.delveDetectMult,
    detonateCorpse: host.detonateCorpse,
    despawnPet: host.despawnPet,
    respawnMob: host.respawnMob,
    frenzyPackmates: host.frenzyPackmates,
    armDeathThroes: host.armDeathThroes,
    despawnPersistentPet: host.despawnPersistentPet,
    clearNonPlayerStatAuras: host.clearNonPlayerStatAuras,
    onBossDeath: host.onBossDeath,
    // M3 mob-swing affix cascade seam.
    effectiveArmor: host.effectiveArmor,
    recalcPlayer: host.recalcPlayer,
    // P1a pet-AI seam.
    syncPetAspect: host.syncPetAspect,
    effectiveAttackPower: host.effectiveAttackPower,
    isHostileTo: host.isHostileTo,
  };
}
