# Debug asset catalogue (`debug.html`)

Standalone page for reviewing **building art** and **procedural worker** previews. Not linked from the main game.

- **URL (dev):** `http://localhost:3000/debug.html` (same Vite origin as the game; port is usually 3000).
- **Entry:** `debug.html` → `src/debug/catalogPage.ts`.
- **Build:** `vite.config.ts` includes `debug.html` in `rollupOptions.input` so `dist/debug.html` ships with production builds.

## When you change art or worker visuals — update this flow

Agents and humans should **keep the catalogue accurate** whenever gameplay-visible sprites or worker drawing changes. Otherwise the debug page drifts from the real game.

### Building sprites (PNG under `assets/buildings/`)

| Change                                                                 | Update                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| New or changed **completed** building sprite                           | `src/catalog/buildingSprites.ts` → `BUILDING_FINAL_SPRITES` (and ensure `EntityFactory` / preload still use the catalog — they import from here).   |
| New or changed **construction** frames (`*_build_*.png`)               | `BUILDING_CONSTRUCTION_SPRITES` in the same file.                                                                                                   |
| New or changed **production / working** facade frames (`*_prod_*.png`) | `BUILDING_PRODUCTION_SPRITES` in the same file. The catalogue **only** shows a production column when this map has an entry for that building type. |

The catalogue **reads** `buildings.json` via `DataManager` for the details column; no extra step for JSON-only field changes unless you want new fields surfaced in `buildingDetailsPanel()` in `catalogPage.ts`.

### Worker visuals (procedural canvas, not PNG sheets)

| Change                                                                                                                   | Update                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawing / pose / carry logic                                                                                             | `src/rendering/WorkerSpritePainter.ts` (shared with `RenderSystem`).                                                                                                                               |
| New **role**, **appearance variant**, **idle animation**, **visual activity**, or held-item behaviour you want showcased | `src/components/Worker.ts` plus **`src/debug/catalogPage.ts`**: add a new **`addCard(anchorKey, caption, { … })`** cell in the worker grid (and use a stable `anchorKey` for `#worker-…` anchors). |
| New **resource icons** drawn on workers                                                                                  | Ensure PNG exists under `assets/resources/` and add the path to **`WORKER_BODY_RESOURCE_SPRITE_PATHS`** in `WorkerSpritePainter.ts` if the catalogue should preload it.                            |

Clothing variants in the grid are driven by **`WORKER_DEFS.peasant.variants`**; adding variants there automatically adds cards. One-off poses still need an explicit `addCard` row.

### Quick checklist before merging art / worker work

1. `src/catalog/buildingSprites.ts` — final / construction / production URL maps.
2. `src/debug/catalogPage.ts` — new worker preview cards if the change is user-visible and not covered by variants alone.
3. Open **`/debug.html`** locally and confirm the new row or column looks correct.

## Related docs

- [Asset Guide](ASSET_GUIDE.md) — naming, folders, and integration steps for PNGs.
- [CLAUDE.md](../CLAUDE.md) — project index; links this doc under **Documentation**.
