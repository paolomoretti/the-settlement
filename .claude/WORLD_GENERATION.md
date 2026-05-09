# World Generation & Terrain Persistence

## Overview

The world is a 1000x1000 tile grid generated procedurally from a seed. Terrain is generated **once** when a new game starts and **stored in the save data** so the map never changes between sessions.

## Terrain Types

| Code | TerrainType | Walkable | Description                              |
| ---- | ----------- | -------- | ---------------------------------------- |
| `g`  | `grass`     | yes      | Default open ground                      |
| `w`  | `water`     | no       | Lakes, rivers, ponds                     |
| `m`  | `mountain`  | no       | Mountain ranges and rock formations      |
| `f`  | `forest`    | yes      | Dense tree clusters (2-4 trees per tile) |
| `t`  | `tree`      | yes      | Single scattered trees                   |
| `h`  | `hill`      | yes      | Elevated terrain near mountains          |
| `d`  | `desert`    | yes      | Unused currently                         |

## Generation Pipeline

All generation is **deterministic** — same seed always produces the same world. The pipeline runs in order:

1. **Base terrain** (`generateTerrain`) — per-tile noise: water bodies, lakes, forests, trees. Forest and scattered-tree thresholds are tuned in `src/config/gameConfig.ts` under `GAME_CONFIG.world.terrain` (see `.claude/GAME_CONFIGURATION.md`).
2. **Rivers** (`generateRivers`) — 2-4 vertical rivers using seeded noise for path wandering
3. **Mountain ranges** (`generateMountainRanges`) — 8-16 horizontal bands placed via noise-based positioning
4. **Rock formations** (`generateRockFormations`) — 300-500 small clusters (1-5 tiles), first 30 guaranteed near base camp
5. **Remove isolated water** (`removeIsolatedWater`) — water tiles with < 2 cardinal water neighbors become grass
6. **Clear base camp area** (`clearBaseCampArea`) — clears water/mountain within building footprint + 4 tile margin
7. **HQ mainland bridge** (`ensureHqMainlandBridge`) — labels orthogonal walkable land components; if HQ’s blob is smaller than the largest continent, converts a shortest water/mountain corridor to `grass` so HQ is not a lake island before the island-removal pass
8. **Remove islands** (`removeIslands`) — BFS flood fill from base camp; unreachable walkable tiles become water
9. **HQ starter trees** (`ensureStarterTreesNearHq`) — new worlds only: if fewer than `hqMinTreeCellsNearHq` `forest`/`tree` cells fall within Chebyshev `hqStarterForestSearchRadius` of HQ center (excluding the HQ footprint), the nearest walkable `grass` tiles are converted to `forest` so early wood is always in reach. Tuned in `GAME_CONFIG.world.terrain`. Runs before water/forest depth passes.

## Save/Load — Terrain Persistence

### How it works

Terrain is saved as an **RLE-compressed string** in the save data under the `terrain` key. This ensures the world never changes after creation, regardless of future algorithm changes.

**Encoding**: `"500g20w30f10t"` = 500 grass, 20 water, 30 forest, 10 tree. Each run is `<count><code>` where code is a single character from the terrain codes table above.

**Size**: For a 1000x1000 map (~1M tiles), RLE typically compresses to 50-200KB depending on terrain variety.

### Serialize flow

`TileMap.serialize()` calls `encodeTerrain()` which scans all tiles row by row (top-left to bottom-right) and produces the RLE string. The save object includes:

```typescript
{
  seed: number,        // Original generation seed (kept for reference)
  width: number,
  height: number,
  terrain: string,     // RLE-encoded terrain — the authoritative world state
  roads: string,       // Semicolon-separated "x,y" coords
  explored: string,    // Semicolon-separated "x,y" coords
  occupied: [...]      // Array of {x, y, id}
}
```

### Deserialize flow

`TileMap.deserialize(data)` bypasses the constructor (uses `Object.create`) to avoid triggering generation. If `data.terrain` exists, it calls `initEmpty()` then `decodeTerrain()` to restore the exact saved terrain. Legacy saves without `terrain` fall back to regenerating from seed.

### Key invariant

**New game** → constructor → `generate()` → world is created from noise
**Load game** → `deserialize()` → `decodeTerrain()` → world is restored exactly as saved

## Determinism

All randomness uses the seeded `NoiseGenerator`. **`Math.random()` is never used** in terrain generation. This means the same seed always produces the same world, but the save still stores the terrain data as the authoritative source in case the algorithm changes in a future update.

## Rendering

Trees, rocks, and mountains are rendered as **per-tile overlays** in `RenderSystem`, drawn after terrain textures but before entities:

1. `renderMountainsOnTiles()` — rounded boulder placeholders on `mountain` tiles
2. `renderTreesOnTiles()` — pine tree placeholders on `tree`/`forest` tiles

Both check for sprite replacements first (see Asset Guide). Rendering is purely visual — it reads `tile.terrain` and draws accordingly. No rendering state is saved.
