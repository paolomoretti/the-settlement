# Performance Guidelines — The Settlement

## Core Principle

This is a large-world game (1000x1000 tiles). Every rendering decision must assume thousands of tiles are on screen. **Never do per-tile work at render time** — pre-compute everything possible at startup or on state change.

## Terrain & Tile Rendering

### Atlas pattern (current approach)
- Each terrain type is a **single pre-rendered sprite atlas** (1024x512 canvas) containing a 16x16 grid of diamond-clipped tiles
- All atlases are generated once at startup using procedural noise
- At render time, each tile is a single `ctx.drawImage()` call with source rect — no pixel manipulation, no noise computation, no canvas creation
- Noise uses **world-space coordinates** so tiles blend seamlessly across boundaries

### Rules for new terrain types or visual features
1. **Never create canvas elements per tile at runtime.** Use the atlas pattern: pre-render into a sprite sheet at startup
2. **Never compute noise or pixel-level effects per frame.** Bake everything into atlas textures
3. **Never use `ctx.clip()`, `ctx.createPattern()`, or `ctx.getImageData()` during the render loop.** These are slow when called thousands of times
4. **Use `ctx.drawImage(atlas, sx, sy, sw, sh, dx, dy, dw, dh)` for tile rendering.** The 9-argument form with source rect is the fastest way to draw from a sprite sheet
5. Diamond masking must be baked into the atlas (transparent pixels outside the diamond), not applied at render time

### Shoreline contour overlay
- Water cells remain tile-based for gameplay and atlas rendering.
- `RenderSystem.renderShorelineContour()` traces explored water/land boundaries with marching squares, simplifies the resulting polylines in screen space, fills closed lake contours, fills darker closed depth-band contours, and strokes a narrow shoreline band over the tile art.
- Keep this as a viewport-bounded vector overlay. Do not reintroduce per-tile clipping rectangles or overlapping ellipse blobs for lake smoothing.

### Adding new terrain types
1. Add a generator function following the existing pattern (world-space coordinates, writes to r/g/b buffers)
2. Register it in the `GENERATORS` map
3. The atlas system handles the rest automatically — no per-tile cache or runtime generation needed

## General Canvas 2D Performance

### Do
- **Viewport cull** — only process tiles/entities within visible bounds (already implemented)
- **Cache viewport bounds** — recalculate only when camera moves (already implemented)
- **Batch similar operations** — minimize state changes (fillStyle, strokeStyle, font)
- **Use offscreen canvases** for UI overlays that don't change every frame (minimap pattern)
- **Sort entities once** per frame, not per draw call
- **Use typed arrays** (Float64Array, Uint8Array) for bulk pixel/data operations

### Don't
- Don't create/destroy canvas elements during gameplay
- Don't use `save()`/`restore()` inside tight loops when you can reset manually
- Don't use string concatenation for colors in hot paths — pre-compute color strings
- Don't use `globalCompositeOperation` changes inside tile loops
- Don't use `ctx.filter` — it forces software rendering on many browsers

## Entity Rendering

- Entities already use viewport culling and depth sorting
- When adding sprite sheets for entities, follow the same atlas pattern
- Worker animation frames should be on a single sprite sheet per unit type
- Limit debug text rendering to development builds or a debug toggle

## Memory Budget

- Terrain atlases: ~2MB per type × 9 types = ~18MB (acceptable)
- Minimap offscreen canvas: 200×200 = ~160KB
- Keep total offscreen canvas memory under 50MB
- If adding more atlas types (seasons, weather variants), consider sharing base atlases and applying tint overlays

## Profiling

When investigating performance:
1. Check FPS counter (already in UI)
2. Use Chrome DevTools Performance tab — look for long frames
3. Common culprits: too many drawImage calls (reduce visible area), GC pauses (avoid object allocation in render loop), excessive state changes
