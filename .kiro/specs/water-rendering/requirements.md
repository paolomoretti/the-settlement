# Requirements Document

## Introduction

This document captures the current water rendering system in Settler as a baseline, along with planned improvements and bug fixes. Settler is a 1000×1000 tile isometric city-builder. Water bodies (lakes, ponds, rivers) are a significant visual and gameplay element: they block movement, host fish populations, and define the landscape. The water rendering pipeline covers terrain generation, shore contour rendering (marching squares), per-tile atlas rendering, depth-based shading, fish cluster management, and decorative fish jump animations.

The goal is to document the existing system accurately so that improvements and fixes can be layered on top with a clear baseline.

A key improvement in this spec is the introduction of a **Water Rendering Mode** setting (mirroring the existing Road Rendering Mode): **smooth** uses the marching-squares contour pipeline exclusively, and **classic** uses the per-tile atlas pipeline exclusively. Currently the system renders both pipelines simultaneously in certain cases (atlas as underlay + contour on top), which is wasteful. The new mode flag eliminates this overlap.

---

## Glossary

- **Water_Tile**: A map tile with `terrain === 'water'`; non-walkable, non-buildable.
- **Lake_Cluster**: The set of all orthogonally (4-way) connected Water_Tiles that form one contiguous body of water. Tracked in `TileMap.waterFishClusterById`.
- **Shore_Tile**: A Water_Tile that has at least one non-water cardinal neighbor.
- **Water_Depth**: A per-tile integer computed by BFS from the shore inward (Chebyshev distance from the nearest non-water tile). Shore tiles have depth 1; deeper interior tiles have higher values.
- **Contour_Path**: A closed polyline produced by the marching-squares algorithm tracing the boundary between water and non-water tiles.
- **Water_Rendering_Mode**: A persistent user setting with two values: `smooth` (marching-squares contour pipeline) and `classic` (per-tile atlas pipeline). Mirrors the existing `RoadRenderingMode` pattern in `debugFlags.ts`.
- **Atlas_Rendering**: The per-tile rendering mode that draws each Water_Tile from the Water_Atlas. Used exclusively in `classic` mode, and as the sole fallback in `smooth` mode only when no closed Contour_Path can be produced.
- **Water_Atlas**: The pre-baked canvas atlas containing 256 shore configurations (4 cardinal + 4 diagonal neighbor bits), 256 linearized variants, and 4 deep-water variants (total 516 cells).
- **Linearized_Shore**: A shore configuration where exactly 2 opposite cardinal neighbors are water (i.e. the tile lies on a straight run); rendered with reduced noise to avoid a jagged edge.
- **Depth_Band**: One of 7 semi-transparent overlay passes (minDepth 2–8) that darken the interior of deep water bodies.
- **Fish_Jump**: A decorative animation of a small fish arcing above the water surface, spawned periodically on a visible, explored Water_Tile with fish remaining.
- **Fish_Cluster_Stock**: The shared `{ remaining, max, cellCount }` record for a Lake_Cluster, stored in `TileMap.waterFishClusterById`.
- **RenderSystem**: The main canvas rendering class (`src/systems/RenderSystem.ts`).
- **TerrainTextures**: The atlas-building and draw-helper class (`src/rendering/TerrainTextures.ts`).
- **TileMap**: The map data class (`src/map/TileMap.ts`) that owns terrain, fish clusters, and water depth.
- **DEBUG_WATER_RENDER_LOG**: A boolean flag in `src/debug/debugFlags.ts`; when `true`, RenderSystem logs a diagnostic line to the console whenever the water render branch or viewport changes.

---

## Requirements

### Requirement 1: Water Tile Generation

**User Story:** As a game designer, I want water bodies to be generated procedurally from a seed, so that every new game has a unique but consistent landscape.

#### Acceptance Criteria

1. THE TileMap SHALL generate Water_Tiles using fractal noise seeded by the map seed: any tile whose elevation value is below `0.17` becomes a Water_Tile, and the same seed SHALL always produce the same set of Water_Tiles.
2. THE TileMap SHALL generate additional lake bodies using a multi-octave lake noise field combined with a wetness modifier; a tile becomes a Water_Tile when its lake noise is below `lakeThreshold` (a seed-derived value in the range `0.16`–`0.48`) and its elevation is below `0.45`.
3. THE TileMap SHALL generate 2–4 vertical rivers by converting a 3-tile-wide column of non-mountain tiles to Water_Tiles, with the column path wandering left or right each row based on noise.
4. AFTER terrain generation, THE TileMap SHALL remove isolated Water_Tiles that have fewer than 2 cardinal water neighbors by converting them to grass.
5. THE TileMap SHALL compute a `waterDepth` integer for every Water_Tile using BFS from the shore outward; tiles with at least one non-water cardinal neighbor receive depth 1, and each step further from the shore increments the depth by 1.
6. WHEN a new game is started, THE TileMap SHALL convert all water and mountain tiles within a 4-tile rectilinear margin around the base camp spawn point to grass to guarantee a buildable starting area.
7. THE TileMap SHALL ensure the HQ starting area is connected to the largest walkable land mass; IF the HQ land blob is smaller than the largest continent, THEN THE TileMap SHALL convert the fewest-tile water/mountain corridor connecting them to grass.

---

### Requirement 2: Water Shore Atlas

**User Story:** As a developer, I want a pre-baked texture atlas for all possible shore configurations, so that per-tile water rendering is fast and visually consistent.

#### Acceptance Criteria

1. THE TerrainTextures SHALL build a Water_Atlas at startup containing exactly 516 cells: 256 standard shore configurations (8-bit neighbor mask: 4 cardinal + 4 diagonal bits), 256 linearized shore variants, and 4 deep-water variants.
2. WHEN rendering a shore cell whose 8-bit neighbor configuration is not 255, THE TerrainTextures SHALL select the atlas cell whose index matches that configuration.
3. THE TerrainTextures SHALL render each shore cell with four distinct visual zones determined by a signed distance field `minF` from the water edge: zone boundary at `minF < 0.18` (grassy transition, alpha 0–130), `minF < 0.32` (stony shore, alpha 180–250), `minF < 0.55` (shallow water with foam highlights, alpha 200–255), and `minF >= 0.55` (deep water interior, alpha 255).
4. WHERE a Water_Tile has exactly 2 cardinal water neighbors that are on opposite sides (north–south or east–west), THE TerrainTextures SHALL use the Linearized_Shore variant for that tile, which applies a noise offset multiplier of `0.35×` to produce a cleaner straight edge.
5. THE TerrainTextures SHALL render 4 deep-water variants (8-bit config 255) using distinct noise seed offsets (e.g. `v * 211 + 500` and `v * 173 + 700` for variant `v`) so that each variant produces a visually different texture.
6. THE TerrainTextures SHALL compute water texture using a periodic noise function with a period equal to the atlas grid cell size, so that adjacent atlas cells share the same noise phase at their shared edge.

---

### Requirement 3: Shoreline Contour Rendering (Smooth Mode)

**User Story:** As a player, I want water bodies to have smooth, organic shorelines rather than blocky tile edges, so that the game world looks natural.

#### Acceptance Criteria

1. WHEN `WATER_RENDERING_MODE` is `smooth` and rendering a frame, THE RenderSystem SHALL run a marching-squares algorithm over the set of grid tiles currently visible within the canvas viewport to collect shoreline segments at the boundary between tiles whose `terrain === 'water'` and `explored === true` and adjacent non-water tiles.
2. WHEN shoreline segments have been collected for the current frame, THE RenderSystem SHALL assemble those segments into ordered polylines (Contour_Paths) and convert each vertex to canvas screen-space coordinates using the active camera transform.
3. WHEN Contour_Paths have been assembled, THE RenderSystem SHALL simplify each polyline using a distance threshold of 12 screen pixels, removing only vertices whose removal causes a deviation of no more than 12 screen pixels from the original polyline path.
4. WHEN polyline simplification is complete, THE RenderSystem SHALL snap nearly-closed Contour_Paths whose endpoints are within 2.5 screen pixels of each other to form closed rings so they qualify for fill operations.
5. WHEN at least one closed Contour_Path exists in the viewport, THE RenderSystem SHALL stroke the closed contours with a semi-transparent green shore outline (`rgba(66, 112, 42, 0.58)`, line width 6) and fill the enclosed area using the water texture pattern or a solid fallback color (`#3484d6`). THE RenderSystem SHALL NOT render any per-tile atlas cells underneath the contour fill.
6. WHEN `WATER_RENDERING_MODE` is `smooth` but no closed Contour_Path exists (e.g. the viewport is entirely inside a lake interior or all polylines are open due to viewport clipping), THE RenderSystem SHALL fall back to Atlas_Rendering for that frame to ensure water is always visible.
7. WHEN `WATER_RENDERING_MODE` is `classic`, THE RenderSystem SHALL NOT run the marching-squares algorithm or draw any contour paths.
8. WHEN closed Contour_Paths are being traced, THE RenderSystem SHALL apply Catmull-Rom-style smoothing using adaptive corner rounding: segments whose interior angle is less than 150 degrees SHALL be rounded with a radius between 4 and 20 screen pixels proportional to the sharpness of the angle, while segments at 150 degrees or greater SHALL be left unrounded.
9. WHEN closed Contour_Paths are being rendered, THE RenderSystem SHALL apply a per-vertex random positional jitter in the range of 0.5 to 3.0 screen pixels to break up the mechanical regularity of the grid-aligned marching-squares output.

---

### Requirement 4: Water Depth Contour Fills

**User Story:** As a player, I want deeper parts of lakes to appear visually darker, so that I can intuitively perceive the depth and shape of water bodies.

#### Acceptance Criteria

1. WHEN closed Contour_Paths are present, THE RenderSystem SHALL render 7 depth band overlay passes on top of the base water fill, one for each minimum depth threshold from 2 to 8, considering only explored Water_Tiles.
2. THE RenderSystem SHALL render each depth band as a semi-transparent filled contour using the same marching-squares and smoothing pipeline as the shore contour, but restricted to explored tiles whose `waterDepth` meets or exceeds the band's threshold.
3. THE RenderSystem SHALL use the following fill colors for each depth band: depth ≥ 2: `rgba(27, 101, 190, 0.17)`, depth ≥ 3: `rgba(22, 88, 170, 0.15)`, depth ≥ 4: `rgba(18, 75, 150, 0.13)`, depth ≥ 5: `rgba(14, 62, 130, 0.11)`, depth ≥ 6: `rgba(10, 50, 110, 0.09)`, depth ≥ 7: `rgba(7, 42, 97, 0.07)`, depth ≥ 8: `rgba(4, 34, 84, 0.05)`.
4. IF a depth band produces no closed contours after simplification, THEN THE RenderSystem SHALL skip that band without error.

---

### Requirement 5: Atlas Rendering (Classic Mode)

**User Story:** As a player, I want a classic per-tile water rendering option that is lightweight and consistent, so that I can choose performance over visual smoothness.

#### Acceptance Criteria

1. WHEN `WATER_RENDERING_MODE` is `classic`, THE RenderSystem SHALL iterate over all explored Water_Tiles in the viewport and draw each tile's atlas cell centered on the tile's isometric screen position. No marching-squares or contour work SHALL be performed.
2. WHEN `WATER_RENDERING_MODE` is `smooth` but no closed Contour_Path can be produced for the current viewport, THE RenderSystem SHALL also use Atlas_Rendering as a fallback to ensure water is always visible.
3. THE RenderSystem SHALL compute the 8-bit neighbor configuration for each Water_Tile by sampling its 4 cardinal and 4 diagonal neighbors and encoding water presence as bits (bit 0 = north, bit 1 = east, bit 2 = south, bit 3 = west, bits 4–7 = diagonals).
4. WHERE a Water_Tile qualifies as a Linearized_Shore (exactly 2 opposite cardinal water neighbors), THE RenderSystem SHALL draw the linearized atlas variant for that tile.
5. THE RenderSystem SHALL use the deep-water atlas variant (cycling through 4 variants by tile position modulo 4) for Water_Tiles whose 8-bit configuration is 255 (all 8 neighbors are water).

---

### Requirement 6: Water Texture Fill

**User Story:** As a developer, I want the water fill inside closed contours to use a procedural texture pattern, so that large water bodies have visual richness rather than a flat color.

#### Acceptance Criteria

1. WHEN TerrainTextures is initialized, THE TerrainTextures SHALL build a water texture canvas using multi-octave noise to produce color variation across the water surface, and the resulting canvas SHALL tile seamlessly (i.e. the noise function SHALL be periodic with period equal to the texture canvas dimensions).
2. WHEN filling a closed Contour_Path, THE RenderSystem SHALL apply the water texture as a canvas fill pattern if `TerrainTextures.useWaterTextureFill()` returns `true`.
3. IF `TerrainTextures.useWaterTextureFill()` returns `false` (e.g. `createPattern()` returned `null`), THEN THE RenderSystem SHALL fill the closed Contour_Path with the solid color `#3484d6`.
4. THE water texture SHALL blend three noise octaves over the base water color `#3a7bd5`: a low-frequency wave layer (noise scale 0.7), a medium ripple layer (noise scale 1.8), and a high-frequency highlight layer (noise scale 4.5) to simulate light reflection.

---

### Requirement 7: Fish Cluster Management

**User Story:** As a player, I want fish populations to be shared across an entire lake, so that fishing from any shore tile of the same lake draws from the same pool.

#### Acceptance Criteria

1. THE TileMap SHALL assign all orthogonally connected Water_Tiles to the same Lake_Cluster; a tile's cluster membership SHALL be observable via `Tile.waterClusterId`, and two tiles with the same non-null `waterClusterId` SHALL belong to the same cluster. Cluster assignment is deferred until the cluster is first queried for fish stock or targeted for a fish catch (capped at 262,144 cells per flood-fill for safety).
2. WHEN a Lake_Cluster is first queried for fish stock or targeted for a fish catch, THE TileMap SHALL initialize the cluster with `max` equal to the sum of per-tile caps (each cap a deterministic value in the range 5–15 derived from the map seed and tile coordinates), `remaining` equal to `max`, and `cellCount` equal to the number of Water_Tiles in the cluster.
3. THE TileMap SHALL store each Lake_Cluster's state as `{ remaining, max, cellCount }` in `TileMap.waterFishClusterById`, keyed by the cluster's ID.
4. WHEN a fish is caught from any Water_Tile in a Lake_Cluster and `remaining > 0`, THE TileMap SHALL decrement the cluster's `remaining` count by 1.
5. WHEN `remaining` reaches 0, THE TileMap SHALL prevent further fish catches from any tile in that cluster until a regeneration tick sets `remaining` above 0.
6. WHEN 7200 in-game seconds have elapsed, THE TileMap SHALL apply `remaining = min(max, remaining + cellCount)` to each initialized Lake_Cluster.
7. WHEN a save is loaded and the save contains a `waterFishClusters` field, THE TileMap SHALL restore each cluster's `{ remaining, max, cellCount }` from that field; IF the save contains only a legacy `waterFish` field with per-tile `{ r, m }` entries, THEN THE TileMap SHALL merge those entries into clusters on the first query or catch targeting any tile in the cluster.

---

### Requirement 8: Decorative Fish Jump Animations

**User Story:** As a player, I want to occasionally see fish jumping out of the water, so that lakes feel alive and dynamic.

#### Acceptance Criteria

1. THE RenderSystem SHALL spawn at most one Fish_Jump per interval, where the interval is a random value between 10,000 ms and 30,000 ms scaled by the current game speed multiplier.
2. WHEN spawning a Fish_Jump, THE RenderSystem SHALL select a random explored (revealed to the player) Water_Tile within the current viewport that belongs to a Lake_Cluster with `remaining > 0`.
3. IF no valid tile is found within 40 random attempts, THEN THE RenderSystem SHALL fall back to a full viewport scan to find any eligible tile before giving up.
4. WHEN a Fish_Jump is spawned, THE RenderSystem SHALL animate it over 1200 ms using a parabolic arc: the fish travels 14 screen pixels horizontally while rising and falling up to 16 screen pixels vertically.
5. WHEN rendering a Fish_Jump, THE RenderSystem SHALL draw the fish body as a small ellipse (5×2 px) with a tail fin and dorsal fin, rotated to follow the arc tangent direction at the current animation progress.
6. WHEN rendering a Fish_Jump, THE RenderSystem SHALL render entry splash rings during the first 12% of the animation (alpha fading from 1.0 to 0.0) and exit splash rings during the last 12% of the animation (alpha fading from 1.0 to 0.0).
7. IF a Fish_Jump entry's elapsed time exceeds 1200 ms, THEN THE RenderSystem SHALL remove it from the active Fish_Jump list.

---

### Requirement 9: Water Insight Highlight

**User Story:** As a player, I want to see a visual highlight when I hover over a water tile with Alt held, so that I can identify the fish cluster and its stock.

#### Acceptance Criteria

1. WHEN the player holds Alt and hovers over an explored Water_Tile (and the game is not in a panning or dragging state), THE RenderSystem SHALL draw a diamond outline around that tile using a bright blue stroke with a visible glow effect to distinguish it from other tile highlights.
2. WHEN the cursor moves off a Water_Tile while Alt is held, THE RenderSystem SHALL clear the water insight highlight immediately.
3. WHEN Alt is released while the cursor is over a Water_Tile, THE RenderSystem SHALL clear the water insight highlight immediately.
4. WHEN the water insight highlight is active, THE Game SHALL display a tooltip showing the lake-wide fish stock as `remaining` fish out of `max` fish, and the percentage of cluster capacity remaining, for the hovered tile's Lake_Cluster; IF the cluster has not yet been initialized, THE Game SHALL trigger lazy initialization before displaying the tooltip.

---

### Requirement 10: Water Render Debug Logging

**User Story:** As a developer, I want optional diagnostic logging for the water rendering pipeline, so that I can diagnose issues like water disappearing at certain zoom levels.

#### Acceptance Criteria

1. WHEN `DEBUG_WATER_RENDER_LOG` is `true` and a render call completes, THE RenderSystem SHALL compute a diagnostic signature and log a diagnostic object to the console only if the signature differs from the signature logged in the previous log entry (not the previous render frame).
2. THE diagnostic log SHALL include: the active render branch (`contour`, `atlas_fallback`, or `none`), total segment count, total polyline count, screen contour count, closed contour count, the `hasWater` boolean, explored and fog water tile counts in the viewport, the position of the first explored water tile found (or `null` if none), viewport tile bounds (`minX`, `maxX`, `minY`, `maxY`, width, height), camera position, zoom level, and canvas dimensions.
3. THE RenderSystem SHALL suppress duplicate log entries by comparing a signature string of all diagnostic fields; a new entry SHALL only be logged when the signature differs from the previous logged entry.
4. THE `DEBUG_WATER_RENDER_LOG` constant SHALL be defined as `false` in `src/debug/debugFlags.ts` and SHALL NOT be changed to `true` in committed code.

---

### Requirement 11: Minimap Water Representation

**User Story:** As a player, I want water bodies to be clearly visible on the minimap, so that I can navigate the map and identify lakes at a glance.

#### Acceptance Criteria

1. THE RenderSystem SHALL paint every tile with `terrain === 'water'` that has been explored on the minimap using the color `#2196f3`.
2. IF a tile has `terrain === 'water'` and has not been explored, THEN THE RenderSystem SHALL paint it on the minimap using the color `#1a1a1a` to preserve fog of war.
3. WHEN a Water_Tile is explored for the first time, THE RenderSystem SHALL update the corresponding minimap pixel within the same render frame in which the exploration is registered.

---

### Requirement 12: Water Rendering Mode Setting

**User Story:** As a player, I want to choose between smooth contour-based water rendering and classic per-tile water rendering, so that I can balance visual quality against performance.

#### Acceptance Criteria

1. THE game SHALL expose a `WaterRenderingMode` type with two values: `smooth` (marching-squares contour pipeline) and `classic` (per-tile atlas pipeline), mirroring the existing `RoadRenderingMode` type in `src/debug/debugFlags.ts`.
2. THE game SHALL expose a mutable `WATER_RENDERING_MODE` export and a `setWaterRenderingMode(mode: WaterRenderingMode)` function in `src/debug/debugFlags.ts`, following the same pattern as `ROAD_RENDERING_MODE` and `setRoadRenderingMode`.
3. THE default value of `WATER_RENDERING_MODE` SHALL be `smooth`.
4. WHEN `WATER_RENDERING_MODE` is `smooth`, THE RenderSystem SHALL use only the marching-squares contour pipeline (Requirement 3), with Atlas_Rendering as a fallback only when no closed contours can be produced.
5. WHEN `WATER_RENDERING_MODE` is `classic`, THE RenderSystem SHALL use only the Atlas_Rendering pipeline (Requirement 5) and SHALL NOT execute any marching-squares, polyline assembly, simplification, or contour drawing code.
6. THE game options UI SHALL include a segmented button control for water rendering mode with two buttons labelled "Smooth" and "Classic", using `data-water-rendering="smooth"` and `data-water-rendering="classic"` attributes, placed adjacent to the existing road rendering mode control.
7. WHEN the player selects a water rendering mode in the options UI, THE game SHALL call `setWaterRenderingMode` with the selected value, update the active button state, and persist the selection to `localStorage` under the same options key used for other settings.
8. WHEN the game loads, THE game SHALL read the persisted water rendering mode from `localStorage` and call `setWaterRenderingMode` with the stored value, defaulting to `smooth` if no value is stored or the stored value is invalid.
9. THE `WATER_RENDERING_MODE` diagnostic log entry SHALL include the current water rendering mode value so that `DEBUG_WATER_RENDER_LOG` output reflects which pipeline is active.
