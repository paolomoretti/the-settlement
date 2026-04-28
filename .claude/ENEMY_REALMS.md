# Enemy realms

Prototype enemy realms are generated for new games by `src/world/EnemyVillageGenerator.ts` and placed from `Game.initializeWorld()`.

## Ownership

Buildings and workers now carry an `Owner` component with a `factionId`. Missing ownership is treated as `player` for legacy saves. Enemy factions use `enemy_1` through `enemy_10`; `enemy_1` is always the red nearby realm, and the remaining factions use distinct navigator / flag / cordon colors from `ownerUtils.ts`.

Player economy systems filter to player-owned entities. Enemy buildings are currently static scenario entities: they render, occupy land, hold storage, own garrisons, project territory, and have roads, but they do not run a separate transport economy yet.

## Territory and cordons

`TerritoryCoordinator` computes exclusive territory layers per faction. A cell is owned by exactly one faction: the faction with the strongest HQ/military push. It remains unassigned when no source reaches it. Exact ties resolve to the player in this prototype so old shared frontier cells do not leave stale enemy cordons inside player land.

The render system accepts multiple cordon layers. Player cordons keep the existing brown poles and ropes; enemy frontiers reuse the same geometry with red rope and red-tinted poles. Because ownership is exclusive, cordons move as territory is recalculated instead of preserving the old line after conquest.

## Initial villages

On new games, ten enemy villages are planned. The first village is placed just outside the initial player territory edge when a valid nearby site exists. The remaining villages are distributed in expanding rings across the map. Village difficulty is derived from the planning index / distance from the player start: farther villages get a larger footprint, more civilian buildings, more military buildings, fuller garrisons, and higher soldier ranks.

Each village flattens only its selected patch and adds a tiny pond for fisher coverage. Only the area around the nearest military post in the first nearby village is revealed; the distant realms stay hidden unless the code-level navigator debug flag is enabled. A village can place:

- one enemy HQ (`base_camp`) with stored resources
- military defenders (`barracks`, `guardhouse`, `watchtower`, and later `fortress`) with scaled seeded garrisons; enemy military disks are capped at 5 cells
- a scaled mix of residential, economy, and food buildings, plus a tiny local pond for the fisher
- BFS-routed internal roads connecting all planned entrances without crossing buildings or water

Enemy realms start dormant. Their buildings, roads, territory, storage, and concealed garrisons exist, but they do not tick production, move workers, or spawn cosmetic farm/street/production animation workers until player territory reaches the realm bounds. This keeps distant generated cities visible in the debug navigator without making them a full simulation cost. Once activated, enemy production buffers do not request player transport pickup, so they do not leak goods into the player economy. Activated farms get a visible field worker, and the realm seeds a few enemy-owned workers on its internal streets for life in the village.

## Debug reveal

`src/debug/debugFlags.ts` has the generic `DEBUG` flag. When set to `true`, the navigator/minimap paints the entire terrain map and overlays building markers for all factions without changing main-canvas fog or exploration state. The main renderer must continue to cull entities by explored footprint, even when they appear in the navigator, so hidden villages do not become a full-world render cost. Future debug-only affordances should use the same flag unless they need a narrower switch. It should stay `false` in normal play.

## Defeat and attacks

Enemy realm defeat is now player-driven through the attack loop in [`MILITARY_ATTACKS.md`](MILITARY_ATTACKS.md). Enemy military buildings and enemy HQ can be attacked directly; capturing the HQ burns non-military enemy buildings, while surviving enemy military buildings keep ownership and territory until separately conquered.

## Save/load

Building save data includes `factionId`, and the generated realm plan is stored as `enemyRealms`. Loaded garrison workers inherit the owning building's faction.
