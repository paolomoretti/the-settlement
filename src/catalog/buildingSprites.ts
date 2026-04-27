/**
 * Single source of truth for building art URLs (final, construction phases, production cycle).
 * Used by the game renderer, entity factory, and the debug asset catalogue page.
 */

/** Completed building sprite per `BuildingType` id (storehouse uses warehouse art). */
export const BUILDING_FINAL_SPRITES: Record<string, string> = {
  base_camp: '/assets/buildings/base_camp.png',
  storehouse: '/assets/buildings/warehouse.png',
  lumberjack: '/assets/buildings/lumberjack.png',
  sawmill: '/assets/buildings/sawmill.png',
  mill: '/assets/buildings/mill.png',
  forester: '/assets/buildings/forester.png',
  quarry: '/assets/buildings/quarry.png',
  hut: '/assets/buildings/hut.png',
  house: '/assets/buildings/house.png',
  fisher: '/assets/buildings/fisher.png',
  hunter: '/assets/buildings/hunter.png',
  well: '/assets/buildings/well.png',
  farm: '/assets/buildings/farm.png',
  pig_farm: '/assets/buildings/pig_farm.png',
  slaughterhouse: '/assets/buildings/slaughterhouse.png',
  bakery: '/assets/buildings/bakery.png',
  brewery: '/assets/buildings/brewery.png',
  coal_mine: '/assets/buildings/coal_mine.png',
  iron_mine: '/assets/buildings/iron_mine.png',
  gold_mine: '/assets/buildings/gold_mine.png',
  granite_mine: '/assets/buildings/granite_mine.png',
  iron_smelter: '/assets/buildings/iron_smelter.png',
  metalworks: '/assets/buildings/metalworks.png',
  mint: '/assets/buildings/mint.png',
  barracks: '/assets/buildings/barracks.png',
  guardhouse: '/assets/buildings/guardhouse.png',
  watchtower: '/assets/buildings/watchtower.png',
  armory: '/assets/buildings/armory.png',
};

/**
 * Construction phase sprites per building type (excluding the completed sprite).
 * During build, total frames = stages.length + 1 (the completed sprite is the last frame).
 */
export const BUILDING_CONSTRUCTION_SPRITES: Record<string, string[]> = {
  storehouse: ['/assets/buildings/warehouse_build_0.png', '/assets/buildings/warehouse_build_1.png'],
  lumberjack: [
    '/assets/buildings/lumberjack_build_0.png',
    '/assets/buildings/lumberjack_build_1.png',
    '/assets/buildings/lumberjack_build_2.png',
  ],
  sawmill: [
    '/assets/buildings/sawmill_build_0.png',
    '/assets/buildings/sawmill_build_1.png',
    '/assets/buildings/sawmill_build_2.png',
  ],
  mill: [
    '/assets/buildings/mill_build_0.png',
    '/assets/buildings/mill_build_1.png',
    '/assets/buildings/mill_build_2.png',
  ],
  forester: [
    '/assets/buildings/forester_build_0.png',
    '/assets/buildings/forester_build_1.png',
    '/assets/buildings/forester_build_2.png',
  ],
  quarry: [
    '/assets/buildings/quarry_build_0.png',
    '/assets/buildings/quarry_build_1.png',
    '/assets/buildings/quarry_build_2.png',
  ],
  hut: [
    '/assets/buildings/hut_build_0.png',
    '/assets/buildings/hut_build_1.png',
    '/assets/buildings/hut_build_2.png',
  ],
  fisher: [
    '/assets/buildings/fisher_build_0.png',
    '/assets/buildings/fisher_build_1.png',
    '/assets/buildings/fisher_build_2.png',
  ],
  hunter: [
    '/assets/buildings/hunter_build_0.png',
    '/assets/buildings/hunter_build_1.png',
    '/assets/buildings/hunter_build_2.png',
  ],
  well: ['/assets/buildings/well_build_0.png'],
  house: [
    '/assets/buildings/house_build_0.png',
    '/assets/buildings/house_build_1.png',
    '/assets/buildings/house_build_2.png',
  ],
  farm: [
    '/assets/buildings/farm_build_0.png',
    '/assets/buildings/farm_build_1.png',
    '/assets/buildings/farm_build_2.png',
  ],
  pig_farm: [
    '/assets/buildings/pig_farm_build_0.png',
    '/assets/buildings/pig_farm_build_1.png',
    '/assets/buildings/pig_farm_build_2.png',
  ],
  slaughterhouse: [
    '/assets/buildings/slaughterhouse_build_0.png',
    '/assets/buildings/slaughterhouse_build_1.png',
    '/assets/buildings/slaughterhouse_build_2.png',
  ],
  bakery: [
    '/assets/buildings/bakery_build_0.png',
    '/assets/buildings/bakery_build_1.png',
    '/assets/buildings/bakery_build_2.png',
    '/assets/buildings/bakery_build_3.png',
  ],
  brewery: [
    '/assets/buildings/brewery_build_0.png',
    '/assets/buildings/brewery_build_1.png',
    '/assets/buildings/brewery_build_2.png',
  ],
  coal_mine: ['/assets/buildings/coal_mine_build_0.png', '/assets/buildings/coal_mine_build_1.png'],
  iron_mine: ['/assets/buildings/iron_mine_build_0.png', '/assets/buildings/iron_mine_build_1.png'],
  gold_mine: ['/assets/buildings/gold_mine_build_0.png', '/assets/buildings/gold_mine_build_1.png'],
  granite_mine: ['/assets/buildings/granite_mine_build_0.png', '/assets/buildings/granite_mine_build_1.png'],
  iron_smelter: [
    '/assets/buildings/iron_smelter_build_0.png',
    '/assets/buildings/iron_smelter_build_1.png',
    '/assets/buildings/iron_smelter_build_2.png',
  ],
  metalworks: [
    '/assets/buildings/metalworks_build_0.png',
    '/assets/buildings/metalworks_build_1.png',
    '/assets/buildings/metalworks_build_2.png',
  ],
  mint: [
    '/assets/buildings/mint_build_0.png',
    '/assets/buildings/mint_build_1.png',
    '/assets/buildings/mint_build_2.png',
  ],
  barracks: [
    '/assets/buildings/barracks_build_0.png',
    '/assets/buildings/barracks_build_1.png',
    '/assets/buildings/barracks_build_2.png',
  ],
  guardhouse: [
    '/assets/buildings/guardhouse_build_0.png',
    '/assets/buildings/guardhouse_build_1.png',
    '/assets/buildings/guardhouse_build_2.png',
  ],
  watchtower: [
    '/assets/buildings/watchtower_build_0.png',
    '/assets/buildings/watchtower_build_1.png',
    '/assets/buildings/watchtower_build_2.png',
  ],
  armory: [
    '/assets/buildings/armory_build_0.png',
    '/assets/buildings/armory_build_1.png',
    '/assets/buildings/armory_build_2.png',
  ],
};

/**
 * Production phase sprites per building type (shown only while actively producing).
 * Naming: `/assets/buildings/<type>_prod_<index>.png`.
 */
export const BUILDING_PRODUCTION_SPRITES: Record<string, string[]> = {
  farm: [
    '/assets/buildings/farm_prod_0.png',
    '/assets/buildings/farm_prod_1.png',
    '/assets/buildings/farm_prod_2.png',
    '/assets/buildings/farm_prod_3.png',
  ],
};

export function collectAllCataloguedBuildingSpritePaths(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(BUILDING_FINAL_SPRITES)) out.add(p);
  for (const stages of Object.values(BUILDING_CONSTRUCTION_SPRITES)) {
    for (const p of stages) out.add(p);
  }
  for (const stages of Object.values(BUILDING_PRODUCTION_SPRITES)) {
    for (const p of stages) out.add(p);
  }
  return [...out];
}
