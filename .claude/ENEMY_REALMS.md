# Enemy realms

Prototype enemy realms are generated for new games by `src/world/EnemyVillageGenerator.ts` and placed from `Game.initializeWorld()`.

## Ownership

Buildings and workers now carry an `Owner` component with a `factionId`. Missing ownership is treated as `player` for legacy saves. The first prototype enemy faction is `enemy_1`.

Player economy systems filter to player-owned entities. Enemy buildings are currently static scenario entities: they render, occupy land, hold storage, own garrisons, project territory, and have roads, but they do not run a separate transport economy yet.

## Territory and cordons

`TerritoryCoordinator` computes exclusive territory layers per faction. A cell is owned by exactly one faction: the faction with the strongest HQ/military push. It remains unassigned when no source reaches it. Exact ties resolve to the player in this prototype so old shared frontier cells do not leave stale enemy cordons inside player land.

The render system accepts multiple cordon layers. Player cordons keep the existing brown poles and ropes; enemy frontiers reuse the same geometry with red rope and red-tinted poles. Because ownership is exclusive, cordons move as territory is recalculated instead of preserving the old line after conquest.

## Initial village

On new games, one compact enemy village is placed just outside the initial player territory edge when a valid nearby site exists. The generator stays well under the 40x40 maximum, flattens only the selected compact patch for this prototype, and reveals only the area around the nearest enemy military post so most of the village remains hidden. It places:

- one enemy HQ (`base_camp`) with stored resources
- three military defenders (`guardhouse`, `watchtower`, `barracks`) with seeded garrisons; enemy military disks are capped at 5 cells
- forester, farm, and fisher test plots, plus a tiny local pond for the fisher
- zero to eight extra buildings chosen from existing no-input or map-gathering building types
- BFS-routed internal roads connecting all planned entrances without crossing buildings or water

Enemy production buildings with no global input dependency are allowed to animate. Enemy production buffers do not request player transport pickup, so they do not leak goods into the player economy. The generated farm also gets a visible field worker, and the realm seeds a few enemy-owned workers on its internal streets for life in the village.

## Defeat and attacks

Enemy realm defeat is now player-driven through the attack loop in [`MILITARY_ATTACKS.md`](MILITARY_ATTACKS.md). Enemy military buildings and enemy HQ can be attacked directly; capturing the HQ burns non-military enemy buildings, while surviving enemy military buildings keep ownership and territory until separately conquered.

## Save/load

Building save data includes `factionId`, and the generated realm plan is stored as `enemyRealms`. Loaded garrison workers inherit the owning building's faction.
