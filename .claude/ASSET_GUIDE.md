# Asset Guide - The Settlement

This guide defines how to create, name, and integrate visual assets for The Settlement game in the style of The Settlers II.

## Table of Contents
1. [Style Reference](#style-reference)
2. [Technical Specifications](#technical-specifications)
3. [Folder Structure](#folder-structure)
4. [Naming Conventions](#naming-conventions)
5. [AI Image Generation Guide](#ai-image-generation-guide)
6. [Integration Guide](#integration-guide)

---

## Style Reference

### The Settlers II Aesthetic
- **Perspective**: Isometric (2:1 ratio) viewed from 45° angle
- **Art Style**: Hand-painted, slightly cartoonish medieval fantasy
- **Color Palette**: Warm, earthy tones with vibrant accents
  - Grass: Rich greens (#7cb342, #689f38)
  - Dirt/Roads: Warm browns (#c4a572, #a68a5a)
  - Stone: Cool grays with warm highlights
  - Water: Deep blues with lighter highlights
  - Wood: Warm browns and tans
- **Lighting**: Consistent light source from top-left
- **Texture**: Hand-drawn quality, visible brush strokes OK
- **Detail Level**: Medium - readable at small sizes but with character
- **Mood**: Cheerful, inviting, productive

### Key Characteristics
- Clear silhouettes
- Consistent shadow direction (bottom-right)
- Slight texture/noise for organic feel
- No anti-aliasing artifacts on edges
- Medieval European architecture style

---

## Technical Specifications

### Isometric Tile Dimensions
- **Base Tile**: 64×32 pixels (width × height)
- **Format**: PNG with transparency (RGBA)
- **Color Depth**: 32-bit (RGB + Alpha)
- **Tile Shape**: Diamond/rhombus (isometric projection)

### Terrain Tiles
```
Dimensions: 64×32 pixels (base diamond)
Format: PNG-24 with alpha
Naming: terrain_[type].png
Examples:
  - terrain_grass.png
  - terrain_water.png
  - terrain_dirt.png
  - terrain_sand.png
```

**Tile Structure**:
```
      32px
    ┌──┬──┐
    │  ▲  │
32px│ ╱ ╲ │ 32px
    │╱   ╲│
    │╲   ╱│
    │ ╲ ╱ │
    │  ▼  │
    └──┴──┘
      32px
```

### Roads
```
Dimensions: 64×32 pixels
Format: PNG-24 with alpha (transparent edges)
Naming: road_[direction].png
Types needed:
  - road_straight_h.png (horizontal)
  - road_straight_v.png (vertical)
  - road_corner_ne.png (northeast corner)
  - road_corner_nw.png (northwest corner)
  - road_corner_se.png (southeast corner)
  - road_corner_sw.png (southwest corner)
  - road_t_n.png (T-junction north)
  - road_t_e.png (T-junction east)
  - road_t_s.png (T-junction south)
  - road_t_w.png (T-junction west)
  - road_cross.png (4-way intersection)
```

### Buildings
```
Dimensions: Variable (based on footprint)
Format: PNG-24 with transparency
Anchor Point: Top-left corner of the base (back corner in isometric view)

Warehouse (3×3 tiles):
  - Canvas size: ~192×180 pixels (3 tiles wide, plus height)
  - Building height: ~80 pixels above ground
  - File: building_warehouse.png

Lumberjack (2×2 tiles):
  - Canvas size: ~128×120 pixels (2 tiles wide, plus height)
  - Building height: ~60 pixels above ground
  - File: building_lumberjack.png

Naming: building_[name].png
```

### Units (Workers, Carriers)
```
Dimensions: ~32×48 pixels (fits within one tile with headroom)
Format: PNG-24 with transparency
Spritesheet: Yes (animations)
Anchor: Bottom-center (feet position)

Spritesheet Layout (8 directions × 4-6 frames):
  - 256×192 pixels (32px per frame, 8 directions, 4 frames each)
  - Directions: N, NE, E, SE, S, SW, W, NW
  - File: unit_worker_walk.png

Naming: unit_[type]_[action].png
```

### UI Elements
```
Format: PNG-24 with transparency
Size: Variable
Naming: ui_[element].png
Examples:
  - ui_button_build.png
  - ui_minimap_frame.png
  - ui_resource_wood.png (16×16 icon)
```

---

## Folder Structure

```
assets/
├── terrain/              # Ground tiles, natural features
│   ├── grass.png
│   ├── water.png
│   ├── dirt.png
│   ├── sand.png
│   ├── forest.png
│   ├── mountain.png
│   └── hill.png
│
├── roads/                # Road tiles and connections
│   ├── straight_h.png
│   ├── straight_v.png
│   ├── corner_ne.png
│   └── ... (all variations)
│
├── buildings/            # Structures
│   ├── warehouse.png
│   ├── lumberjack.png
│   ├── sawmill.png
│   ├── quarry.png
│   ├── farm.png
│   └── ... (future buildings)
│
├── units/                # Animated characters
│   ├── worker_walk.png   # Spritesheet
│   ├── worker_carry.png  # Carrying animation
│   ├── worker_build.png  # Building animation
│   └── ... (future units)
│
└── ui/                   # Interface elements
    ├── buttons/
    ├── icons/
    └── panels/
```

---

## Naming Conventions

### Format
```
[category]_[name]_[variant].png
```

### Rules
1. **Lowercase only**: Use lowercase letters
2. **Underscores**: Separate words with underscores
3. **Descriptive**: Name should describe what it is
4. **No spaces**: Never use spaces in filenames
5. **No version numbers**: Use git for versioning

### Examples
✅ Good:
- `terrain_grass.png`
- `building_warehouse.png`
- `road_corner_ne.png`
- `unit_worker_walk.png`

❌ Bad:
- `Grass.png` (uppercase)
- `warehouse-1.png` (version number)
- `road NE.png` (space in name)
- `temp.png` (not descriptive)

---

## AI Image Generation Guide

### Base Prompt Template

Use this template for **ALL** asset generation to maintain consistency:

```
Create an isometric [ASSET_TYPE] sprite in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 2:1 ratio, viewed from 45° angle
- Hand-painted medieval fantasy aesthetic
- Warm, earthy color palette with visible brush strokes
- Lighting from top-left, shadows bottom-right
- Cheerful and inviting mood
- Clear, readable silhouette
- Slightly cartoonish but detailed

Technical specs:
- Dimensions: [WIDTH]×[HEIGHT] pixels
- Transparent background (PNG)
- Isometric diamond tile shape
- [ADDITIONAL_SPECS]

The asset is: [DETAILED_DESCRIPTION]

Reference style: The Settlers II, Anno 1602, classic isometric strategy games
```

### Specific Prompts

#### Grass Terrain Tile
```
Create an isometric grass terrain tile in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 2:1 ratio, viewed from 45° angle
- Hand-painted medieval fantasy aesthetic
- Rich green colors (#7cb342, #689f38)
- Lighting from top-left, subtle shading bottom-right
- Slightly varied grass texture with small detail
- Cheerful and vibrant

Technical specs:
- Dimensions: 64×32 pixels
- Transparent background (PNG)
- Isometric diamond/rhombus shape
- Grass should look lush and healthy

The grass tile should show:
- Short grass texture
- Subtle color variation for natural look
- Maybe small flowers or clover details (optional)
- Matches medieval European countryside

Reference style: The Settlers II grass tiles
```

#### Water Terrain Tile
```
Create an isometric water terrain tile in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 2:1 ratio, viewed from 45° angle
- Hand-painted medieval fantasy aesthetic
- Deep blue colors with lighter highlights (#2196f3)
- Subtle wave/ripple pattern
- Light reflection on surface
- Cheerful but calm

Technical specs:
- Dimensions: 64×32 pixels
- Transparent background (PNG)
- Isometric diamond shape
- Should tile seamlessly with other water tiles

The water should show:
- Gentle wave patterns
- Light playing on surface
- Slight movement suggestion (not animated, just painted)
- Clear, clean medieval stream/lake water

Reference style: The Settlers II water tiles
```

#### Road Tile
```
Create an isometric dirt road tile in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 2:1 ratio, viewed from 45° angle
- Hand-painted medieval fantasy aesthetic
- Warm brown colors (#c4a572, #a68a5a)
- Well-trodden dirt path appearance
- Lighting from top-left
- Cheerful medieval atmosphere

Technical specs:
- Dimensions: 64×32 pixels
- Transparent edges that blend with grass
- Isometric diamond shape
- [DIRECTION: straight horizontal/vertical/corner/etc.]

The road should show:
- Packed dirt surface
- Cart wheel ruts (subtle)
- Slightly worn, well-traveled path
- Dusty brown color, lighter than grass
- Soft edges that blend into surrounding terrain

Reference style: The Settlers II road system
```

#### Warehouse Building (3×3)
```
Create an isometric warehouse building in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 2:1 ratio, viewed from 45° angle
- Hand-painted medieval fantasy aesthetic
- Stone/wood construction, medieval European style
- Lighting from top-left, shadows bottom-right
- Cheerful, productive atmosphere
- Tan/brown colors (#d4a574)

Technical specs:
- Base footprint: 3×3 tiles (192 pixels wide)
- Building height: ~80 pixels above ground
- Canvas size: 192×180 pixels
- Transparent background (PNG)
- Anchor point: top-left corner of base

The warehouse should show:
- Large storage building with multiple stories
- Stone foundation, wooden upper structure
- Visible doors and windows
- Thatched or shingled roof
- Storage barrels or crates visible (optional)
- Sturdy, well-built appearance
- Medieval German/European architecture

Reference style: The Settlers II warehouse building
```

#### Worker Unit (Spritesheet)
```
Create an isometric worker character spritesheet in the style of The Settlers II (1996).

Style requirements:
- Isometric perspective, 8 directions (N, NE, E, SE, S, SW, W, NW)
- Hand-painted medieval fantasy aesthetic
- Small, cheerful character design
- Simple clothing (medieval peasant/worker)
- Clear silhouette, readable at small size

Technical specs:
- Spritesheet: 256×192 pixels (8 directions × 4 frames)
- Each frame: 32×48 pixels
- Transparent background (PNG)
- Walking animation (4 frames per direction)
- Anchor: bottom-center (feet)

Layout:
Row 1: North direction (4 frames)
Row 2: Northeast direction (4 frames)
Row 3: East direction (4 frames)
Row 4: Southeast direction (4 frames)
Row 5: South direction (4 frames)
Row 6: Southwest direction (4 frames)

The worker should show:
- Simple tunic and pants
- Walking motion (legs moving)
- Cheerful expression
- Medieval peasant appearance
- Clear, bouncy walk cycle

Reference style: The Settlers II carrier/worker units
```

### Tips for AI Generation

1. **Be specific**: Include exact dimensions and technical requirements
2. **Reference The Settlers II explicitly**: This helps the AI understand the style
3. **Consistent palette**: Always mention the same color codes
4. **Include "isometric"**: Critical for perspective
5. **Multiple attempts**: Generate 3-5 versions and pick the best
6. **Refinement**: If style drifts, emphasize "exactly like The Settlers II (1996)"
7. **Lighting consistency**: Always mention "lighting from top-left"

---

## Integration Guide — Adding a Building Sprite

When the user provides a building sprite image (via prompt attachment, file path, etc.), follow these steps to integrate it. No other code changes are needed beyond what's described here.

### Step 1: Save the image to `assets/buildings/`

The filename **must** match the building's `BuildingType` id (from `src/types/GameData.ts`).

```
assets/buildings/<buildingType>.png
```

Valid building type ids (see `src/types/GameData.ts` for the full list):

| BuildingType     | Sprite path                          | Tile size |
|------------------|--------------------------------------|-----------|
| `base_camp`      | `assets/buildings/base_camp.png`     | 6x6       |
| `warehouse`      | `assets/buildings/warehouse.png`     | 3x3       |
| `lumberjack`     | `assets/buildings/lumberjack.png`    | 2x2       |
| `sawmill`        | `assets/buildings/sawmill.png`       | 2x2       |
| `quarry`         | `assets/buildings/quarry.png`        | 2x2       |
| `farm`           | `assets/buildings/farm.png`          | 3x2       |

### Step 2: Set `spritePath` in `EntityFactory.ts`

In `src/entities/EntityFactory.ts`, find the `SPRITE_PATHS` map and add the building type:

```typescript
const SPRITE_PATHS: Record<string, string> = {
  base_camp: '/assets/buildings/base_camp.png',
  warehouse: '/assets/buildings/warehouse.png',
  lumberjack: '/assets/buildings/lumberjack.png',  // <-- add new entries here
};
```

The Renderable component will automatically be created with type `'sprite'` when a spritePath is found, and the RenderSystem will lazy-load and cache the image on first render.

### Step 3 (optional): Add construction phase sprites

Buildings have build times. You can provide multiple sprites showing construction progress. Save them as:

```
assets/buildings/<type>_build_0.png   ← construction start (foundation, materials)
assets/buildings/<type>_build_1.png   ← mid-construction (framing, walls)
assets/buildings/<type>.png           ← completed building (already exists)
```

Then register them in `src/systems/RenderSystem.ts` in the `CONSTRUCTION_SPRITES` map:

```typescript
const CONSTRUCTION_SPRITES: Record<string, string[]> = {
  warehouse: [
    '/assets/buildings/warehouse_build_0.png',
    '/assets/buildings/warehouse_build_1.png',
  ],
};
```

**How it works:** The build sprites + the completed sprite = total frames. The build time is divided equally among all frames. For a 60s warehouse with 2 build sprites + 1 completed = 3 frames → each shown for 20s. You can provide any number of build sprites per building. Buildings without construction sprites keep the existing opacity fade effect.

### How the sprite system works

- **Lazy loading:** `RenderSystem.loadSprite()` starts loading on the first frame a sprite is needed and caches the `HTMLImageElement` in a `spriteCache` Map. The building is invisible until the image loads (no placeholder flash).
- **Auto-scaling:** `RenderSystem.renderBuildingSprite()` scales the sprite to fit the building's isometric diamond footprint. The footprint width is `(tileWidth + tileDepth) * 32` pixels. The sprite's aspect ratio is preserved.
- **Positioning:** The sprite is centered horizontally on the footprint and anchored at the bottom to the footprint's front (south) corner.
- **Selection:** Yellow diamond outline is drawn over the footprint when selected, same as other buildings.
- **Fallback:** Buildings without a `spritePath` still render as procedural 3D isometric boxes using their `color` property.

### Sprite geometry — how sprites align to the tile grid

The renderer scales the sprite so its **full width matches the building's isometric footprint width**, then anchors the **bottom-center of the image to the front (south) corner** of the diamond. For the sprite to align with the tile grid, the isometric base diamond in the image must follow these rules:

```
              (back/north corner)
                     *
                    / \
image top →  ------/---\------
              |   /     \   |
              |  /       \  |
  left edge → * (base)    * ← right edge
              |  \       /  |
              |   \     /   |
              |    \   /    |
              |     \ /     |
image bot →   ------*------
              (front/south corner)
              ↑  bottom-center  ↑
```

**Rules for the base diamond in the sprite:**

1. **Left (west) corner** touches the **left edge** of the image
2. **Right (east) corner** touches the **right edge** of the image
3. **Front (south) corner** is at the **bottom-center** of the image
4. **Diamond height = exactly half the image width** (the 2:1 isometric ratio)
5. The building structure extends **above** the base diamond (adding to image height)

The image can be any pixel size — the renderer auto-scales. What matters is that these proportional rules hold.

#### Reference dimensions per building size

These are the exact pixel dimensions of the isometric footprint for each building. The sprite image width should match (or be proportional to) the footprint width. The image height = base height + however tall the building structure is above ground.

| Building     | Tiles (WxD) | Footprint width | Base height | Notes |
|--------------|-------------|-----------------|-------------|-------|
| `base_camp`  | 6x6         | 384px           | 192px       | Square — diamond is centered |
| `warehouse`  | 3x3         | 192px           | 96px        | Square — diamond is centered |
| `lumberjack` | 2x2         | 128px           | 64px        | Square — diamond is centered |
| `sawmill`    | 2x2         | 128px           | 64px        | Square — diamond is centered |
| `quarry`     | 2x2         | 128px           | 64px        | Square — diamond is centered |
| `farm`       | 3x2         | 160px           | 80px        | Non-square — see below |

**Formula:** footprint width = `(W + D) * 32`, base height = `(W + D) * 16`

#### Non-square buildings (e.g. farm 3x2)

For square buildings (W=D), the diamond is perfectly centered — the left and right corners are at the same height, and the back corner is at top-center. For non-square buildings, the left and right corners are at different heights:

- Left (west) corner: left edge, `W * 16` px from the bottom
- Right (east) corner: right edge, `D * 16` px from the bottom

The front corner is still at bottom-center. Just make sure the base diamond shape in the sprite reflects the correct W:D ratio.

### AI prompt tip for sprite generation

When generating a building sprite with AI, include this in the prompt:

> The building sits on an isometric diamond base. The diamond must span the full width of the image. The front (south) point of the diamond must be at the bottom-center of the image. The diamond's height is exactly half its width (2:1 isometric ratio). The building structure rises above this diamond base. Use a transparent background.

### Quick checklist

- [ ] Image saved to `assets/buildings/<buildingType>.png`
- [ ] `spritePath` added to the correct `case` in `EntityFactory.ts`
- [ ] Base diamond spans full image width (left/right corners touch edges)
- [ ] Front corner at bottom-center of image
- [ ] Diamond height is half the image width (2:1 ratio)
- [ ] Transparent background, PNG format
- [ ] Tested in-game (`npm run dev`) — sprite aligns with tile grid

---

## Integration Guide — Terrain Object Sprites (Trees & Rocks)

Trees and rocks are rendered per-tile during the terrain pass. The renderer checks for sprite files first and falls back to procedural placeholders if none are found.

### Sprite Paths

| Terrain type | Sprite path | Placeholder |
|---|---|---|
| Single tree (`tree` terrain) | `assets/terrain/tree_single.png` | Pine tree (stacked green triangles) |
| Forest cluster (`forest` terrain) | `assets/terrain/tree_forest.png` | 2-4 smaller pine trees per tile |
| Rock / mountain (`mountain` terrain) | `assets/terrain/rock.png` | Rounded grey boulder dome |

### How it works

1. **Automatic detection:** `RenderSystem` calls `loadSprite()` for each sprite path. If the file exists and loads successfully (`naturalWidth > 0`), it's used. Otherwise the procedural placeholder renders.
2. **Lazy loading & caching:** Same sprite cache as buildings — loaded on first access, cached forever.
3. **No code changes needed:** Just drop the PNG file at the correct path and reload.

### Sprite specifications

#### Tree sprites (`tree_single.png`, `tree_forest.png`)

- **Dimensions:** Any size — auto-scaled to tile width (64px)
- **Aspect ratio:** Preserve natural aspect ratio; height scales proportionally
- **Anchor:** Bottom-center of the image aligns with tile center, shifted up by half tile height
- **Transparency:** PNG with transparent background
- **Style:** Isometric perspective, hand-painted, Settlers II aesthetic
- **`tree_single.png`:** One tree, centered in frame. Should look natural on a single tile
- **`tree_forest.png`:** Dense cluster of 2-4 trees filling the tile. Used for forest terrain where tiles are adjacent — design so edges blend when tiled

#### Rock sprite (`rock.png`)

- **Dimensions:** Any size — auto-scaled to ~110% of tile width for slight overlap
- **Anchor:** Bottom-center aligns with tile center, shifted up by 40% of tile height
- **Transparency:** PNG with transparent background
- **Style:** Rocky boulder, rounded/dome shape, grey-brown tones
- **Height variation:** Isolated rocks appear small; clustered rocks (mountain ranges) appear as connected elevated terrain. The sprite is used for ALL mountain tiles regardless of cluster size — consider making the sprite work as a repeating boulder that looks natural when adjacent tiles also show the same sprite
- **Lighting:** Top-left light source, darker bottom-right shadow

### AI prompt for tree sprite

```
Create an isometric tree sprite in the style of The Settlers II (1996).

Style: Hand-painted medieval fantasy, warm earthy palette, isometric 2:1 ratio.
The tree should be a deciduous/conifer mix, cheerful and lush.
Lighting from top-left, shadow to bottom-right.
Transparent background (PNG).
The tree should fit within a 64x32 pixel isometric tile base,
with the trunk centered on the tile and canopy extending upward.
The bottom of the trunk should align with the center of the tile diamond.
```

### AI prompt for rock sprite

```
Create an isometric rock/boulder sprite in the style of The Settlers II (1996).

Style: Hand-painted medieval fantasy, grey-brown rocky tones.
The rock should be a rounded boulder with a dome/half-sphere shape.
Lighter on top-left (lit side), darker on bottom-right (shadow).
Some cracks and surface texture for detail.
Transparent background (PNG).
The boulder should sit within a 64x32 pixel isometric tile diamond,
slightly overflowing the edges for a natural look.
```

### Per-tile variation

The procedural placeholders use seeded hash values per tile for size, position offset, color shade, and tree count (in forests). When providing sprites, a single image is used for all tiles of that type. To add variation in the future, the system could be extended to support numbered variants (e.g., `tree_single_1.png`, `tree_single_2.png`) selected by tile hash.

---

## Integration Guide — Adding a Resource Sprite

When the user provides a resource sprite image, follow these steps. **Only one step is needed — save the file. No code changes required.**

### Step 1: Save the image to `assets/resources/`

The filename **must** match the resource's id (from `src/data/resources.json` / `src/types/GameData.ts`).

```
assets/resources/<resourceId>.png
```

That's it. The icon will automatically appear in:
- **Inventory panel** — before the resource name
- **Building production bubble** — the small pill above buildings showing buffered output
- **Building popover** — the detailed buffer breakdown when clicking a building

All three locations use the same path pattern `/assets/resources/{resourceId}.png` and gracefully hide the icon if the file doesn't exist.

### Resource id reference

**Raw Materials:** `wood_log`, `stone`, `coal`, `iron_ore`, `gold_ore`, `granite`

**Refined Materials:** `wood_plank`, `iron_bar`, `gold_bar`

**Food:** `grain`, `flour`, `bread`, `water`, `fish`, `meat`

**Tools:** `hammer`, `axe`, `saw`, `pickaxe`, `shovel`, `fishing_rod`, `scythe`

**Weapons:** `sword`, `shield`, `bow`

### Sprite image requirements

- **Format:** PNG with transparent background
- **Size:** 96x96 pixels (recommended). The icon is displayed at 20x20 in the UI panels and 14x14 in production bubbles, so it gets scaled down. 96x96 gives clean downscaling.
- **Style:** Hand-painted, slightly cartoonish, Settlers II aesthetic
- **Rendering:** `image-rendering: pixelated` is applied in CSS so pixel art scales cleanly
- **Content:** The item on its own, centered in the frame, no background

### How it works under the hood

- **Inventory panel** (`src/main.ts`): Each inventory row includes an `<img src="/assets/resources/{id}.png">` with `onerror="this.style.display='none'"` so missing sprites are hidden gracefully.
- **Building popover** (`src/ui/BuildingPopover.ts`): Buffer display includes the same `<img>` pattern for each resource in the output buffer.
- **Production bubble** (`src/systems/RenderSystem.ts`): The canvas-rendered pill bubble loads sprites via `loadSprite('/assets/resources/{id}.png')` — the same lazy-load cache used by buildings. All resource sprites are preloaded at startup.

---

## Future Expansion

As the project grows, add:
- Animation frames for units
- Seasonal variations (winter grass, autumn trees)
- More building construction stage sprites
- UI theme assets
- Particle effects (smoke, sparkles)

Always maintain consistency with the original Settlers II aesthetic!

---

**Last Updated**: 2026-04-19  
**Game Version**: 0.1.0
