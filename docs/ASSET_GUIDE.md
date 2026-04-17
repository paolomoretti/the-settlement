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

## Integration Guide

### Step 1: Save Asset
1. Generate image using AI with appropriate prompt
2. Review image for style consistency and technical requirements
3. Save to correct folder in `/assets/`
4. Use proper naming convention
5. Verify dimensions and transparency

### Step 2: Import in Code

Create or update asset loader:

```typescript
// src/assets/AssetLoader.ts
export class AssetLoader {
  private static images = new Map<string, HTMLImageElement>();
  
  static async loadImage(path: string): Promise<HTMLImageElement> {
    if (this.images.has(path)) {
      return this.images.get(path)!;
    }
    
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.images.set(path, img);
        resolve(img);
      };
      img.onerror = reject;
      img.src = path;
    });
  }
  
  static async loadTerrain(): Promise<void> {
    await Promise.all([
      this.loadImage('/assets/terrain/grass.png'),
      this.loadImage('/assets/terrain/water.png'),
      this.loadImage('/assets/terrain/dirt.png'),
      // ... etc
    ]);
  }
  
  static getImage(path: string): HTMLImageElement | undefined {
    return this.images.get(path);
  }
}
```

### Step 3: Update RenderSystem

Replace programmatic rendering with sprite rendering:

```typescript
// In RenderSystem.ts
private renderGrass(tile: Tile): void {
  const img = AssetLoader.getImage('/assets/terrain/grass.png');
  if (img) {
    const screenPos = this.iso.gridToScreen(tile.x, tile.y);
    this.ctx.drawImage(
      img,
      screenPos.x - 32, // Center horizontally
      screenPos.y - 16  // Center vertically
    );
  } else {
    // Fallback to current programmatic rendering
    // ... existing code
  }
}
```

### Step 4: Preload Assets

In main.ts, load before starting game:

```typescript
async function init() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  
  // Show loading screen
  console.log('Loading assets...');
  
  // Preload all assets
  await AssetLoader.loadTerrain();
  await AssetLoader.loadBuildings();
  await AssetLoader.loadUnits();
  
  // Start game
  const game = new Game(canvas);
  game.start();
  
  console.log('🎮 Game started with assets loaded!');
}
```

---

## Checklist for New Assets

Before considering an asset complete:

- [ ] Correct dimensions for asset type
- [ ] PNG format with transparency
- [ ] Follows naming convention
- [ ] Saved in correct folder
- [ ] Matches Settlers II style (warm colors, hand-painted)
- [ ] Isometric perspective (2:1 ratio)
- [ ] Lighting from top-left
- [ ] Transparent background (no white edges)
- [ ] Tested in-game
- [ ] Git committed with descriptive message

---

## Future Expansion

As the project grows, add:
- Animation frames for units
- Seasonal variations (winter grass, autumn trees)
- Building construction stages
- Resource icons
- UI theme assets
- Particle effects (smoke, sparkles)

Always maintain consistency with the original Settlers II aesthetic!

---

**Last Updated**: 2026-04-17  
**Game Version**: 0.1.0
