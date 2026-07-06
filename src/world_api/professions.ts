import type { MaterialRarity } from '../sim/professions/gathering';
import type { PlayerProfessionSkill, ProfessionRecipeRecord } from '../sim/professions/types';

// Render-safe projection of a player's professions standing. Stub as of
// #1164, now real for the gathering professions (#1119): `skills` carries one
// entry per gathering profession (Mining/Logging/Herbalism), independent
// additive counters. Crafting/secondary professions still contribute nothing
// until #1120/#1125/#1126/#1140 land.
export interface PlayerProfessionsView {
  skills: readonly PlayerProfessionSkill[];
}

// Static content read: the common-tier recipe list (issue #1127). A plain
// data read (no per-player state), so it needs no wire round-trip: both
// worlds serve the same content table directly (Sim from src/sim/data.ts,
// ClientWorld from the same import, since recipe content ships with the
// client bundle like every other content table).
export type RecipeDef = ProfessionRecipeRecord;

// Craft-result surface (#1127): the outcome of one craftItem command, mirrored
// from the server's `craftResult` event so the client can render a toast/log
// line without deciding the outcome itself. `null` until the first craft
// attempt of the session.
export interface CraftResultView {
  ok: boolean;
  recipeId: string;
  itemId?: string;
  count?: number;
  quality?: MaterialRarity;
  reason?: 'unknown_recipe' | 'insufficient_materials';
}

// The professions read-surface facet (#1164, extended by #1127). `Sim`
// (src/sim/sim.ts `professionsState`/`professionsStateFor`) and `ClientWorld`
// (src/net/online.ts, mirrored from the `prof` wire delta) both implement
// this; see src/sim/professions/CLAUDE.md for the settled wire/persistence
// key names. `nodeHarvestableByMe` (#1121) is per-VIEWER, never global:
// whether the given gather node (see src/sim/content/gather_nodes.ts, #1120)
// is harvestable right now BY THE LOCAL VIEWER specifically. Two players
// asking about the same node id can get different answers, because each
// player's respawn timer for a node is independent (see
// src/sim/professions/gathering.ts). `recipeList`/`craftItem`/
// `lastCraftResult` (#1127) are the first crafting-action members: recipes
// exist as content, and a player can craft a common-tier recipe if they have
// required materials.
export interface IWorldProfessions {
  professionsState: PlayerProfessionsView;
  nodeHarvestableByMe(nodeId: string): boolean;
  harvestNode(nodeId: string): void;
  recipeList: readonly RecipeDef[];
  lastCraftResult: CraftResultView | null;
  craftItem(recipeId: string): void;
}
