// World bosses: server-wide elites that rise on a fixed cadence, announce
// themselves, and reward every player who damaged them with PERSONAL loot, gated
// to once per day per boss.
//
// This module owns the world-boss DATA (the spawn registry) and the pure pieces of
// the system: the per-player daily-loot gate, the contributor set derived from a
// boss's hate table, and the personal-loot roller. The SCHEDULER state and the
// spawn primitive live on `Sim` (it needs createMob/addEntity/groundPos), which
// drives this module each tick; the loot roller is reached through the SimContext
// seam (ctx.rollWorldBossLoot), exactly like ctx.rollLoot.
//
// Determinism (this is sim-core): no Math.random/Date.now, randomness is ctx.rng
// only, and the daily boundary is the host-injected ctx.utcDay string (empty in
// headless/replay, so the gate never rolls over and same-seed runs reproduce). The
// personal-loot roller draws rng in a FIXED order (contributors sorted by entityId,
// loot entries in array order) so the parity gate's rng draw-order log stays stable.

import { MOBS } from './data';
import type { PlayerMeta } from './sim';
import type { SimContext } from './sim_context';
import type { Entity, LootSlot } from './types';

// Sim-time cadence: a fresh boss rises this many seconds after the previous one
// was scheduled. On the live server the sim runs at wall-clock speed (20 Hz), so
// this is "every hour". Lives here with the system that uses it.
export const WORLD_BOSS_INTERVAL_SECONDS = 1 * 3600;

// How long a slain world boss's lootable corpse lingers before it is removed. Much
// longer than a normal corpse so every contributor has time to walk over and loot
// their personal drops; the scheduler drops the entity once this elapses.
export const WORLD_BOSS_CORPSE_SECONDS = 300;

export interface WorldBossDef {
  // MobTemplate id (must have `worldBoss: true`).
  templateId: string;
  // Fixed overworld spawn point (y is grounded at spawn time).
  pos: { x: number; z: number };
  // Seconds of sim time between scheduled spawns.
  intervalSeconds: number;
  // Retail-style HP scaling. The boss spawns at `base` HP and gains `perPlayer` more
  // for each participant beyond the first (counted from its hate table), capped at
  // `max`. It only ever scales UP within a spawn, so a raid that grows keeps the
  // bigger pool even as members die; a fresh spawn resets to `base`.
  hpScale: { base: number; perPlayer: number; max: number };
}

// The world bosses of the live world. One per entry; the scheduler tracks each
// independently. Thunzharr rises at Stormcrag in Thornpeak Heights.
export const WORLD_BOSSES: readonly WorldBossDef[] = [
  {
    templateId: 'thunzharr_waking_peak',
    pos: { x: 110, z: 760 },
    intervalSeconds: WORLD_BOSS_INTERVAL_SECONDS,
    // 40k solo, +40k per extra participant, up to 2M (~50 players), so a crowd cannot
    // melt him in a minute; the pool scales hard with raid size.
    hpScale: { base: 40_000, perPlayer: 40_000, max: 2_000_000 },
  },
];

// Per-player daily loot record. `date` is the UTC day the `looted` set belongs to;
// `looted` holds the boss template ids already looted that day.
export interface WorldBossDaily {
  date: string;
  looted: Set<string>;
}

export function emptyWorldBossDaily(): WorldBossDaily {
  return { date: '', looted: new Set() };
}

// Roll the daily window over when the host's UTC day changes. A no-op when the day
// is unknown (headless/replay, utcDay === ''), keeping replays reproducible.
export function refreshWorldBossDaily(meta: PlayerMeta, utcDay: string): void {
  if (utcDay && meta.worldBossDaily.date !== utcDay) {
    meta.worldBossDaily = { date: utcDay, looted: new Set() };
  }
}

// Eligible if this player has not already looted this boss today. When the calendar
// day is unknown (utcDay === ''), there is no daily window to enforce, so the player
// is always eligible (offline/headless play is non-authoritative).
export function isWorldBossLootEligible(meta: PlayerMeta, bossId: string, utcDay: string): boolean {
  refreshWorldBossDaily(meta, utcDay);
  if (!utcDay) return true;
  return !meta.worldBossDaily.looted.has(bossId);
}

// Record that this player looted this boss today (so they cannot loot it again
// until the daily reset). Called from lootCorpse when a personal world-boss slot
// is actually taken, NOT at kill/roll time. A no-op when the calendar day is unknown.
export function markWorldBossLooted(meta: PlayerMeta, bossId: string, utcDay: string): void {
  if (!utcDay) return;
  refreshWorldBossDaily(meta, utcDay);
  meta.worldBossDaily.looted.add(bossId);
}

// The players who contributed to (damaged or healed against) this boss, derived
// from its hate table. Pet threat is credited to the pet's owner; the set is
// deduped and resolved to live PlayerMeta, then sorted by entityId so any
// downstream rng draws happen in a fixed order. Read BEFORE handleDeath clears the
// boss's threat.
export function worldBossContributors(ctx: SimContext, mob: Entity): PlayerMeta[] {
  const seen = new Set<number>();
  const out: PlayerMeta[] = [];
  for (const attackerId of mob.threat.keys()) {
    const attacker = ctx.entities.get(attackerId);
    // controlled pets credit their owner; everyone else credits themselves. A pet
    // already despawned at the death frame cannot resolve to its owner (the hate
    // table holds only the pet's id), so that credit is dropped: rare, and
    // deterministic either way.
    const pid = attacker && attacker.ownerId !== null ? attacker.ownerId : attackerId;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const meta = ctx.players.get(pid);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.entityId - b.entityId);
}

// Retail-style participant HP scaling, driven each tick by the scheduler while the
// boss is alive. The target pool is `base + perPlayer * (participants - 1)` clamped
// to `max`, where participants is the deduped player count on the hate table. It only
// grows the pool (never shrinks it within a spawn, so members dying does not make the
// boss easier), and adds the same delta to current HP so the extra health is real,
// not a heal. Draws no rng (pure arithmetic over a sorted set), so it never perturbs
// the shared draw stream.
export function scaleWorldBossHp(ctx: SimContext, boss: Entity, def: WorldBossDef): void {
  // Once the pool is at the cap it can never grow again, so skip the per-tick
  // contributors recompute (a dedupe + sort over the hate table) for the rest of the
  // fight, which is thousands of ticks.
  if (boss.maxHp >= def.hpScale.max) return;
  const participants = worldBossContributors(ctx, boss).length;
  const target = Math.min(
    def.hpScale.max,
    def.hpScale.base + def.hpScale.perPlayer * Math.max(0, participants - 1),
  );
  if (target > boss.maxHp) {
    const delta = target - boss.maxHp;
    boss.maxHp = target;
    // Adding delta to current HP too nudges the HP FRACTION up (a boss at 50% of 40k
    // becomes ~58% of 48k). That is intentional ("real health, not a heal"), but note
    // the side effect: a participant joining right as the boss crosses an hp-fraction
    // threshold (the 20% enrage, a summonAdds gate) can push it back above and delay
    // that trigger. Acceptable: it only ever happens while the raid is still growing.
    boss.hp = Math.min(boss.maxHp, boss.hp + delta);
  }
}

// Drop PERSONAL loot for a slain world boss: every contributor who has not already
// looted this boss today gets an independent roll of the boss's loot table, added
// to the shared corpse as `personalFor` slots only that player can take. Mirrors
// rollLoot's per-entry semantics (exclusive rollGroups via one partitioned draw,
// plain per-entry chance) but runs the whole table once per eligible contributor.
// SUPPORTED ENTRY SHAPES: itemId with optional rollGroup only. Unlike rollLoot,
// there is no questId gating and no per-entry copper here; a world-boss loot
// table must not use those fields (they would hand quest items to everyone
// ungated / silently drop the copper).
export function rollWorldBossLoot(ctx: SimContext, mob: Entity, contributors: PlayerMeta[]): void {
  const template = MOBS[mob.templateId];
  if (!template) return;
  const items: LootSlot[] = mob.loot?.items ?? [];
  const copper = mob.loot?.copper ?? 0;
  // contributors arrive sorted by entityId (worldBossContributors); iterate in that
  // fixed order so the rng draw order is deterministic for the parity gate.
  // Eligibility is checked here, but the daily lockout is consumed only when the
  // player actually LOOTS a personal slot (lootCorpse in interaction.ts): a
  // contributor who dies or never reaches the corpse inside the loot window keeps
  // their daily and can try again at the next spawn. Corpse windows (300s) never
  // overlap the 3h cadence, so at most one corpse is ever lootable at a time.
  for (const meta of contributors) {
    if (!isWorldBossLootEligible(meta, mob.templateId, ctx.utcDay)) continue;
    const rolledGroups = new Set<string>();
    for (const entry of template.loot) {
      if (entry.rollGroup) {
        if (rolledGroups.has(entry.rollGroup)) continue;
        rolledGroups.add(entry.rollGroup);
        const group = template.loot.filter((l) => l.rollGroup === entry.rollGroup);
        const roll = ctx.rng.next();
        let cumulative = 0;
        for (const g of group) {
          cumulative += g.chance;
          if (roll < cumulative) {
            if (g.itemId) items.push({ itemId: g.itemId, count: 1, personalFor: [meta.entityId] });
            break;
          }
        }
        continue;
      }
      if (!ctx.rng.chance(entry.chance)) continue;
      if (entry.itemId)
        items.push({ itemId: entry.itemId, count: 1, personalFor: [meta.entityId] });
    }
  }
  if (copper > 0 || items.length > 0) {
    mob.loot = { copper, items };
    mob.lootable = true;
  }
}
