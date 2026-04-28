# Enemy realms

Prototype enemy realms are generated for new games by `src/world/EnemyVillageGenerator.ts` and placed from `Game.initializeWorld()`.

## Ownership

Buildings and workers now carry an `Owner` component with a `factionId`. Missing ownership is treated as `player` for legacy saves. Enemy factions use `enemy_1` through `enemy_10`; `enemy_1` is always the red nearby realm, and the remaining factions use distinct navigator / flag / cordon colors from `ownerUtils.ts`.

Player economy systems filter to player-owned entities. Enemy buildings are currently static scenario entities: they render, occupy land, hold storage, own garrisons, project territory, and have roads, but they do not run a separate transport economy yet.

## Territory and cordons

`TerritoryCoordinator` computes exclusive territory layers per faction. A cell is owned by exactly one faction: the faction with the strongest HQ/military push. It remains unassigned when no source reaches it. Exact ties resolve to the player in this prototype so old shared frontier cells do not leave stale enemy cordons inside player land.

The render system accepts multiple cordon layers. Player cordons keep the existing brown poles and ropes; enemy frontiers reuse the same geometry with red rope and red-tinted poles. Because ownership is exclusive, cordons move as territory is recalculated instead of preserving the old line after conquest.

## Initial villages

On new games, enemy villages are planned from `GAME_CONFIG.enemyRealms`. The first village is placed just outside the initial player territory edge when a valid nearby site exists. The remaining villages are distributed in expanding rings across the map. Village difficulty is derived from the planning index / distance from the player start: farther villages get a larger footprint, more civilian buildings, more military buildings, fuller garrisons, and higher soldier ranks.

Each `EnemyVillagePlan` also stores `aggressivenessLevel` from `GAME_CONFIG.enemyRealms.aggressivenessByVillageIndex`. Level `0` is passive; the nearby red starter realm uses this level and never launches raids. Levels `1` through `5` increase raid frequency, max attackers per raid, and reinforcement pressure.

Each village flattens only its selected patch and adds a tiny pond for fisher coverage. Only the area around the nearest military post in the first nearby village is revealed; the distant realms stay hidden unless the code-level navigator debug flag is enabled. A village can place:

- one enemy HQ (`base_camp`) with stored resources
- military defenders (`barracks`, `guardhouse`, `watchtower`, and later `fortress`) with scaled seeded garrisons; enemy military disks are capped at 5 cells
- a scaled mix of residential, economy, and food buildings, plus a tiny local pond for the fisher
- BFS-routed internal roads connecting all planned entrances without crossing buildings or water

Enemy realms start dormant. Their buildings, roads, territory, storage, and concealed garrisons exist, but they do not tick production, move workers, or spawn cosmetic farm/street/production animation workers until player territory reaches the realm bounds. This keeps distant generated cities visible in the debug navigator without making them a full simulation cost. Once activated, enemy production buffers do not request player transport pickup, so they do not leak goods into the player economy. Activated farms get a visible field worker, and the realm seeds a few enemy-owned workers on its internal streets for life in the village.

Active and visible enemy realms also run `Game.updateEnemyRoadMaintenance()` on the cadence from `GAME_CONFIG.enemyRealms.roadMaintenance`. This is the home for lightweight enemy infrastructure checks, not a full economy. The first pass looks for faction-owned military posts that are no longer connected to that faction's HQ road network. If one exists, the realm may place one completed, garrisoned forward `barracks` near the isolated post and near its frontier, then try to road-connect HQ → barracks and barracks → isolated post. Nearby existing barracks suppress repeat placement so a blocked corridor does not spam buildings every tick.

The second pass repairs ordinary road disconnections. It finds enemy buildings that require roads but are not connected to the enemy HQ road network, then uses the same buildable-road pathfinder as the player with enemy-specific rules: no exploration requirement, stay inside that faction's territory interior, avoid water/mountain/occupied tiles, and prefer existing roads. Both forward barracks and road repairs are capped per tick so large villages do not spike pathfinding cost.

## Debug reveal

`src/debug/debugFlags.ts` has the generic `DEBUG` flag. When set to `true`, the navigator/minimap paints the entire terrain map and overlays building markers for all factions without changing main-canvas fog or exploration state. The main renderer must continue to cull entities by explored footprint, even when they appear in the navigator, so hidden villages do not become a full-world render cost. Future debug-only affordances should use the same flag unless they need a narrower switch. It should stay `false` in normal play.

## Defeat and attacks

Enemy realm defeat is now driven by territory pressure and the attack loop in [`MILITARY_ATTACKS.md`](MILITARY_ATTACKS.md). Enemy military buildings and enemy HQ can be attacked directly; capturing the HQ burns non-military enemy buildings, while surviving enemy military buildings keep ownership and territory until separately conquered. Separately, when player territory expands over enemy civilian buildings, `Game.applyPlayerTerritoryPressureAftermath()` burns those non-military buildings and drops their goods for pickup. The same territory aftermath is symmetric: if an enemy raid captures a player military post and enemy territory expands over player civilian buildings, those player buildings burn as well.

Activated enemy realms with aggressiveness `> 0` run a throttled border-pressure loop in `Game.updateEnemyBorderPressure()`. When an enemy faction's exclusive territory shares a cardinal boundary with player territory, that realm:

- slowly reinforces empty garrison slots in its military buildings, using rank based on aggressiveness
- schedules sporadic attacks after the configured first-contact delay and cooldown
- targets player-owned military buildings in range, not civilian buildings
- reuses the same duel/conquest runtime as player attacks, with ownership transferring to the attacking enemy faction if the raid wins

Enemy realms still do not run a full independent economy; garrison reinforcement is the current abstraction for "feeding" border military buildings until a separate AI economy exists.

## Save/load

Building save data includes `factionId`, and the generated realm plan is stored as `enemyRealms`, including activation/aggression attack timers. Loaded garrison workers inherit the owning building's faction. Active raids are runtime-only and are not serialized.
