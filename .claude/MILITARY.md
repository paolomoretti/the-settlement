# Military (garrison, HQ assembly, territory, payroll)

## Soldier creation (HQ)

- **Automatic:** on the same ~2s timer as other HQ dispatches (`recheckProductionInputDeliveries`), the game tries once per tick to train **one** soldier for the first military post that has a **free slot**, **no soldier already walking there**, **HQ holds sword+shield**, **free settler slot**, and a **road path** HQ→fort. Silent when blocked; no button required.
- **Manual:** the popover **Train soldier** does the same check with on-screen toasts on failure.
- Costs **1× available settler slot**, **1× `sword`**, and **1× `shield`** from **HQ storage** only (weapons must be physically at HQ — armory buffer counts as “not at HQ” until road workers deliver).
- Spawns a **`Worker` with `role: 'military'`** at the HQ road tile, paths on roads to the fort’s entrance road tile, then fills the first free **garrison slot** (rank **1**). The unit stays a soldier forever (`concealedInBuildingId` while garrisoned).

## Population accounting

- `getAvailablePopulation()` / road-worker peasant slots subtract **`getTotalMilitaryGarrisonedCount()`** (filled garrison slots), so garrisoned soldiers are not double-used.
- In-flight HQ→fort walks are reserved via `militaryDispatchWorkers` in `GameWorkerRegistry` (same family as tool/builder maps).

## Territory vision

- `TerritoryCoordinator` adds a **vision disk** for a building with `military.territoryVisionRadius` only when **`soldierCapacity` is unset** (e.g. lookout: still “complete building”) **or** when **`soldierCapacity > 0` and `Building.hasMilitaryTerritoryContributor()`** (≥1 garrisoned soldier). Barracks-line forts **do not** expand land until the first soldier arrives.

## Armory alternation

- `Production.armoryNextOutput` toggles **`sword` / `shield`** each finished cycle. Buffer checks use `getEffectiveOutputs('armory')`.

## Gold promotions (fort)

- Barracks-line buildings have **`Storage` accepting only `gold_coin`**.
- `Game.tryDispatchMilitaryGoldPayroll()` (same throttle path as HQ→production inputs) sends coins from HQ while the fort **`militaryWantsMoreGold()`** (any garrison rank &lt; 3) and nothing is already in-flight for that fort.
- On each **`gold_coin`** delivery to that storage, **`tryConsumeMilitaryGoldAfterDelivery`** removes one coin from the fort and promotes **one** soldier by **one** rank (lowest rank first, then lowest slot index). Coins are **not** stockpiled long-term when a promotion happens.

## Save / load

- `getSaveData` persists `militaryGarrison` as `{ rank, workerEntityId } | null` per slot. Load repairs missing worker entities by clearing orphan slots.

## Art

- `WorkerSpritePainter`: `role === 'military'` uses a dedicated **sword + shield** silhouette; rank **2** adds grey **horned hood**, rank **3** adds **gold trim**.
