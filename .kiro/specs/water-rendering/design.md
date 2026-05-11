# Design Document: Water Rendering System

## Overview

The water rendering system in Settler is a multi-layered pipeline that covers terrain generation, shore contour rendering, per-tile atlas rendering, depth-based shading, fish cluster management, decorative fish jump animations, and a player-facing rendering mode toggle. The system is implemented across three primary files:

- **`src/map/TileMap.ts`** — terrain generation, water depth BFS, fish cluster state
- **`src/rendering/TerrainTextures.ts`** — water atlas construction, water texture fill
- **`src/systems/RenderSystem.ts`** — all runtime rendering: contour pipeline, atlas fallback, depth fills, fish jumps, insight highlight, minimap, debug logging
- **`src/debug/debugFlags.ts`** — `WATER_RENDERING_MODE` flag and setter
- **`src/main.ts`** — options UI wiring and localStorage persistence

---

## Architecture

### Data Flow

```
TileMap.generate()
  └─ generateTerrain()        → tile.terrain = 'water'
  └─ generateRivers()         → additional water tiles
  └─ removeIsolatedWater()    → prune lone water tiles
  └─ computeWaterDepth()      → tile.waterDepth (BFS from shore)

TileMap (lazy, on first fish query)
  └─ ensureWaterFishClusterAt() → waterFishClusterById (shared pool per lake)

TerrainTextures (startup)
  └─ buildWaterAtlas()        → 516-cell canvas (256 shore + 256 linearized + 4 deep)
  └─ buildTextureFill()       → seamless water texture canvas for contour fill pattern

RenderSystem.renderTiles()
  └─ renderTile()             → grass base under water tiles; flat-shore grass clip
  └─ renderShorelineContour() → dispatches to contour or atlas pipeline

  [smooth mode, closed contours exist]
  └─ collectShorelineContourSegments()  → marching-squares segments
  └─ buildContourPolylines()            → chain segments into polylines
  └─ simplifyShorelinePolyline()        → Ramer-Douglas-Peucker (12px tolerance)
  └─ snapNearlyClosedScreenContour()    → snap endpoints within 2.5px
  └─ jitterClosedShoreline()            → normal-direction noise jitter
  └─ traceSmoothedScreenContour()       → quadratic Bézier corner rounding
  └─ stroke (green shore edge) + fill (water texture pattern or #3484d6)
  └─ renderWaterDepthContourFills()     → 7 depth band overlays

  [smooth mode, no closed contours — viewport inside lake]
  └─ renderWaterTilesAsAtlasFallback()  → per-tile atlas draw

  [classic mode]
  └─ renderWaterTilesAsAtlasFallback()  → per-tile atlas draw only

RenderSystem.renderFishJumps()
  └─ spawnFish()              → random explored water tile with fish remaining
  └─ renderFish()             → parabolic arc, body + fins, splash rings

RenderSystem.renderTile() (insight highlight)
  └─ insightHighlightWater    → cyan diamond stroke on hovered water tile (Alt held)

RenderSystem (minimap)
  └─ paintMinimapTile()       → #2196f3 for explored water, #1a1a1a for fog water
```

---

## Component Designs

### 1. Water Tile Generation (`TileMap`)

Water tiles are placed in three passes during `generate()`:

**Pass 1 — Elevation noise** (`generateTerrain`):

- `fractalNoise(x, y, 4) < 0.17` → water

**Pass 2 — Lake noise** (`generateTerrain`):

- Multi-octave lake noise (3 octaves at scales 0.1, 0.22, 0.38) combined with a wetness modifier
- Threshold: `0.16 + max(0, wetness - 0.32) * 0.32` (range 0.16–0.48)
- Only applies when elevation < 0.45

**Pass 3 — Rivers** (`generateRivers`):

- 2–4 rivers, each a top-to-bottom walk with a 3-tile-wide column
- Column wanders ±1 tile per row based on noise; skips mountain tiles

**Post-processing**:

- `removeIsolatedWater()`: removes water tiles with fewer than 2 orthogonal water neighbors
- `clearBaseCampArea()`: converts water/mountain within 4-tile margin of HQ spawn to grass
- `ensureHqMainlandBridge()`: BFS corridor to connect HQ land blob to largest continent

**Water depth** (`computeWaterDepth()`):

- BFS from all tiles adjacent to non-water (8-directional neighbors)
- Shore tiles (adjacent to land) receive depth 1; each BFS step increments by 1
- Stored in `tile.waterDepth`; non-water tiles get depth 0

---

### 2. Water Shore Atlas (`TerrainTextures`)

The atlas is a pre-baked `HTMLCanvasElement` with 516 cells arranged in a 16-column grid:

| Cell range | Content                                                 |
| ---------- | ------------------------------------------------------- |
| 0–255      | Standard shore configs (8-bit neighbor mask)            |
| 256–511    | Linearized shore variants (same configs, reduced noise) |
| 512–515    | Deep water variants (config=255, 4 noise offsets)       |

**Cell layout**: `col = cellIndex % 16`, `row = floor(cellIndex / 16)`, each cell is 64×32 px.

**`renderWaterCell(data, noise, cellIndex, config, noiseOx, noiseOy, linearizeShore)`**:

The 8-bit `config` encodes neighbor water presence:

- Bits 0–3: cardinal neighbors (NW, NE, SE, SW in isometric terms)
- Bits 4–7: diagonal neighbors (only set when both adjacent cardinals are water)

For each pixel inside the diamond mask:

1. Compute 4 iso-edge distance fields (`fNW`, `fNE`, `fSE`, `fSW`) — linear functions of pixel position
2. Set inactive edges to 99 (effectively infinite distance)
3. Apply smooth-min blending (`smin` with k=0.55) across active edges → `minF`
4. For non-linearized cells: add corner rounding for diagonal-pair configs (CORNER_R=18)
5. Apply noise jitter to `minF` (two octaves; multiplied by 0.35 for linearized)
6. Map `minF` to 4 visual zones:
   - `minF ≤ 0.13`: transparent (skip pixel)
   - `0.13–0.22`: grassy transition (alpha 0–130, grass-tinted)
   - `0.22–0.35`: stony shore (grey-brown, wet darkening, stone scatter noise)
   - `0.35–0.5`: shallow water (lighter blue, foam highlights)
   - `> 0.5`: deep water (full `#3a7bd5` color, specular highlights)

**Linearized variant**: when `linearizeShore=true`, `minF` is computed as the minimum of only the active (non-water) edge distances, without smooth-min blending. This produces a cleaner straight edge for tiles on a straight shore run.

**Deep water variants**: config=255 (all 8 neighbors water), 4 variants with different noise offsets (`v * 211 + 500`, `v * 173 + 700`).

**Seamless tiling**: `tileNoise()` uses 4-sample bilinear blend with period `ATLAS_GRID=16` to ensure adjacent atlas cells share the same noise phase at shared edges.

---

### 3. Water Texture Fill (`TerrainTextures`)

`buildTextureFill(genWater, noise)` builds a full `1024×512` canvas (no diamond mask — full rectangle) using `genWater()`:

```
genWater(x, y, noise):
  n1 = tileNoise(scale=0.7)   → low-frequency wave layer
  n2 = tileNoise(scale=1.8)   → medium ripple layer
  n3 = tileNoise(scale=4.5)   → high-frequency highlight layer
  w = (n1-0.5)*30 + (n2-0.5)*15
  rgb = WATER (#3a7bd5) + w * [0.4, 0.6, 1.0]
  if n3 > 0.72: add specular highlight
```

`useWaterTextureFill(ctx)`:

- Creates/caches a `CanvasPattern` from the texture canvas at scale 0.45
- Sets `ctx.fillStyle` to the pattern
- Returns `false` if `createPattern()` returns null (fallback to `#3484d6`)

---

### 4. Shoreline Contour Pipeline (`RenderSystem`, smooth mode)

**Entry point**: `renderShorelineContour(viewportBounds)` — called at the end of `renderTiles()`.

#### Step 1: Marching Squares — `collectContourSegments(viewportBounds, isInside)`

Iterates a 2-cell-padded viewport. For each 2×2 cell quad, computes a 4-bit index from the `isInside` predicate on the 4 corners. Maps to one of 16 cases producing 0, 1, or 2 edge-midpoint segments. The 16 cases cover all standard marching-squares configurations including the two ambiguous cases (5 and 10) which each produce 2 segments.

`collectShorelineContourSegments()` uses `tile.isExplored() && tile.terrain === 'water'` as the predicate.

#### Step 2: Polyline Assembly — `buildContourPolylines(segments)`

Builds an adjacency map keyed by `"x,y"` string. Traversal:

1. Start from degree-1 endpoints first (open chain ends)
2. Walk greedily, preferring unused segments, avoiding backtracking
3. Stop when returning to start (closed loop) or no unused neighbors
4. Consume remaining unused segments as additional loops

#### Step 3: Simplification — `simplifyShorelinePolyline(points, tolerance=12)`

Converts grid-space points to screen-space first, then applies Ramer-Douglas-Peucker:

- For closed rings: splits at leftmost point and its antipodal point, simplifies each arc independently, rejoins
- Tolerance: 12 screen pixels (depth bands use 16)

#### Step 4: Snap — `snapNearlyClosedScreenContour(points)`

If first and last points are within 2.5 screen pixels (squared distance < 6.25), snaps the last point to the first. This ensures rings that drift slightly open during simplification still qualify as closed for jitter and fill.

#### Step 5: Jitter — `jitterClosedShoreline(points)`

For closed rings only (≥5 points):

- Computes the tangent direction at each vertex from its neighbors
- Applies normal-direction displacement: `amount = (n1-0.5)*5.2 + (n2-0.5)*1.8`
- `n1 = shorelineNoise(x*0.035, y*0.035)`, `n2 = shorelineNoise(x*0.085+17.3, y*0.085-41.7)`
- `shorelineNoise` is a sin-based hash: `sin(x*127.1 + y*311.7) * 43758.5453123`, fractional part

#### Step 6: Smoothing — `traceSmoothedScreenContour(points)`

Quadratic Bézier corner rounding for each vertex:

- Computes `sharpness = 1 - angle/π` (0 = straight, 1 = sharp)
- `factor = 0.5 + sharpness * 1.1` (range 0.5–1.6)
- `distance = min(rawDistance, prevLen*0.48, nextLen*0.48, 54)`
- Entry/exit points at `distance` along incoming/outgoing edges
- `quadraticCurveTo(control=vertex, exit)` for each corner
- Segments between corners use `lineTo`

#### Step 7: Fill & Stroke

```
// Shore outline
ctx.strokeStyle = 'rgba(66, 112, 42, 0.58)'
ctx.lineWidth = 6
ctx.stroke()

// Water fill
terrainTextures.useWaterTextureFill(ctx) || (ctx.fillStyle = '#3484d6')
ctx.fill('evenodd')
```

`evenodd` fill rule handles nested contours (islands within lakes) correctly.

#### Fallback

When smooth mode produces no closed contours (viewport fully inside a lake, or all polylines clipped open by the viewport edge), `renderWaterTilesAsAtlasFallback()` is called instead.

---

### 5. Water Depth Contour Fills (`RenderSystem`)

`renderWaterDepthContourFills(viewportBounds)` runs after the base water fill in smooth mode.

7 passes, each using the same marching-squares + simplify + smooth pipeline as the shore contour, but with `tile.waterDepth >= band.minDepth` as the predicate:

| Band | minDepth | Fill color                 |
| ---- | -------- | -------------------------- |
| 1    | 2        | `rgba(27, 101, 190, 0.17)` |
| 2    | 3        | `rgba(21, 86, 172, 0.145)` |
| 3    | 4        | `rgba(16, 72, 154, 0.12)`  |
| 4    | 5        | `rgba(11, 60, 136, 0.095)` |
| 5    | 6        | `rgba(8, 50, 118, 0.075)`  |
| 6    | 7        | `rgba(6, 42, 101, 0.06)`   |
| 7    | 8        | `rgba(4, 34, 84, 0.05)`    |

Simplification tolerance is 16px (slightly looser than the shore contour's 12px). Bands with no closed contours are skipped silently.

---

### 6. Atlas Rendering — Classic Mode & Fallback (`RenderSystem`)

`renderWaterTilesAsAtlasFallback(viewportBounds)`:

For each explored water tile in the viewport:

1. `getWaterConfig(x, y)` → 8-bit neighbor mask
2. `shouldUseLinearizedWaterAtlas(x, y)` → checks `isLinearizedWaterHalfShore()`
3. `terrainTextures.drawWater(ctx, config, tileX, tileY, screenCenterX, screenCenterY, useLinearized)`

`drawWater()` selects the atlas cell:

- Config=255 (all neighbors water): `DEEP_WATER_OFFSET + (tileX+tileY) & 3` (cycles 4 deep variants)
- Linearized: `WATER_LINEARIZE_OFFSET + config`
- Otherwise: `config`

**Linearized shore detection** (`isLinearizedWaterHalfShore`):

- True if the tile is part of a run of ≥2 tiles with the same cardinal mask (axis-aligned)
- Also true for diagonal stair patterns matching road corner pairs (card=9↔6, card=3↔12)

**Flat shore grass clip** (`tryWaterFlatShoreCut`, `applyFlatShoreGrassClip`):

- For water tiles with 2–3 water cardinal neighbors forming a straight run, computes a world-space half-plane boundary
- Adjacent grass tiles use this clip to avoid rendering over the water contour with a W-shaped zigzag
- Applied in `renderTile()` before drawing the grass atlas tile

---

### 7. Water Rendering Mode (`debugFlags.ts` + `main.ts`)

**Flag**: `WATER_RENDERING_MODE: WaterRenderingMode` (`'smooth'` | `'classic'`), default `'smooth'`

**Setter**: `setWaterRenderingMode(mode: WaterRenderingMode)`

**Runtime behavior** in `renderShorelineContour()`:

- `'classic'`: skips all marching-squares work; calls `renderWaterTilesAsAtlasFallback()` directly if any explored water is in viewport
- `'smooth'`: runs full contour pipeline; falls back to atlas only when no closed contours exist

**Options UI** (`main.ts`):

- `[data-water-rendering="smooth"]` and `[data-water-rendering="classic"]` buttons
- On click: `setWaterRenderingMode(mode)` + sync `is-active` / `aria-pressed` + `persistAll()`
- On load: `loadOptions()` → `setWaterRenderingMode(opts.waterRenderingMode)` + sync buttons

**Persistence** (`localStorage`):

- Key: `'settler_options'` (shared with all other options)
- Field: `waterRenderingMode`
- `normalizeWaterRenderingMode()` defaults to `'smooth'` for unknown/missing values

---

### 8. Fish Cluster Management (`TileMap`)

**Cluster assignment** (lazy, on first fish query):

`ensureWaterFishClusterAt(wx, wy)`:

1. If tile already has a `waterClusterId`, return existing cluster
2. BFS flood-fill (orthogonal only, cap=262,144 cells) to collect all connected water tiles
3. Sum `rollWaterFishSchoolMax(seed, x, y)` per cell → cluster `max` (each cell contributes 5–15)
4. Set `remaining = max`, `cellCount = cell count`
5. Assign `waterClusterId` to all member tiles
6. Migrate legacy per-tile `waterFishSchoolMax`/`waterFishRemaining` fields if present

**State**: `waterFishClusterById: Map<number, { remaining, max, cellCount }>`

**Fish catch**: `takeOneWaterFishAt(x, y)` — decrements `cluster.remaining`; returns false if 0

**Regeneration**: `applyWaterFishPopulationRegen()` — called every ~7200 in-game seconds:

```
cluster.remaining = min(cluster.max, cluster.remaining + cluster.cellCount)
```

**Serialization**: `waterFishClusters` array in save data; legacy `waterFish` per-tile field supported on load.

---

### 9. Decorative Fish Jump Animations (`RenderSystem`)

**Spawn timing**: `nextFishSpawn` (wall-clock). Gap = random in `[10_000, 30_000]` ms.

**`spawnFish(now)`**:

1. 40 random attempts: pick random tile in viewport, check `terrain === 'water'`, `isExplored()`, `getWaterFishRemainingAt() > 0`
2. Fallback: full viewport scan, collect all eligible tiles, pick randomly

**`renderFish(tileX, tileY, progress, hash)`**:

- `progress` = `elapsed / 1200` (0→1)
- Position: `fishX = baseX + (progress-0.5)*14*dir`, `fishY = baseY - 16*4*progress*(1-progress)`
- Rotation: `atan2(tangentY, 14*dir)` — follows arc tangent
- Body: ellipse 5×2 px (`#a0b5c5`)
- Belly: half-ellipse 4×1 px (`#c5d4e0`)
- Tail: triangle at body rear (`#8a9fb0`)
- Dorsal fin: small triangle on top (`#8a9fb0`)
- Eye: circle r=0.7 (`#1a1a1a`)
- Splash rings: `progress < 0.12` (entry) or `progress > 0.88` (exit) — ellipse strokes fading from alpha 0.5 to 0

---

### 10. Water Insight Highlight (`RenderSystem`)

Rendered in `renderTile()` when `insightHighlightWater` matches the tile:

- Diamond outline using `iso.getTileCorners()`
- `strokeStyle = 'rgba(120, 200, 255, 0.95)'`, `lineWidth = 2.5`
- `shadowColor = 'rgba(80, 160, 255, 0.65)'`, `shadowBlur = 12`

Set/cleared by the input system when Alt is held and the cursor is over an explored water tile. Tooltip shows cluster `remaining`/`max` fish count and percentage.

---

### 11. Minimap Water Representation (`RenderSystem`)

In `paintMinimapTile()`:

- Explored water tile → `#2196f3` (bright blue)
- Unexplored water tile → `#1a1a1a` (fog color)

Updated incrementally via `updateMinimapTiles()` when tiles are explored, or rebuilt fully in debug mode.

---

### 12. Water Render Debug Logging (`RenderSystem`)

`logWaterRenderDiagIfChanged(state)` — gated by `DEBUG_WATER_RENDER_LOG`:

Signature string (dedup key):

```
branch | segmentsLen | polylinesLen | closedContoursLen | hasWater |
exploredWater | fogWater | minX | maxX | minY | maxY |
camera.x | camera.y | camera.zoom | canvas.width | canvas.height
```

Log object fields:

- `wallMs`, `branch` (`'contour'` | `'atlas_fallback'` | `'none'`)
- `contour`: `{ segments, polylines, screenContours, closedContours }`
- `hasWaterFlag`, `waterTilesInView: { explored, fog }`
- `firstExploredWater: { x, y } | null`
- `viewport: { minX, maxX, minY, maxY, width, height }`
- `camera: { x, y, zoom }`, `canvas: { width, height }`

`DEBUG_WATER_RENDER_LOG` is always `false` in committed code.

---

## Key Invariants

1. Water tiles always have a grass tile drawn underneath them (in `renderTile`). The contour fill or atlas draw paints over it.
2. In smooth mode, the atlas is never drawn as an underlay beneath the contour fill — the two pipelines are mutually exclusive per frame.
3. `evenodd` fill rule is used for all contour fills so that islands (land enclosed by water) are correctly left unfilled.
4. Fish cluster state is lazy — a cluster is only initialized when first queried. Serialization preserves cluster state across saves.
5. `WATER_RENDERING_MODE` is a module-level mutable export (not a React/Vue state), so changes take effect on the next render frame without any additional wiring.
6. The `waterDepth` BFS uses 8-directional neighbors (including diagonals), so depth increases smoothly even in diagonal lake interiors.
