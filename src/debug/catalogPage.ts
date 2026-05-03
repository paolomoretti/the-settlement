/**
 * Standalone debug catalogue: buildings (timed sprite cycles) and worker canvas previews.
 */

import { dataManager } from '@/data/DataManager';
import {
  BUILDING_CONSTRUCTION_SPRITES,
  BUILDING_FINAL_SPRITES,
  BUILDING_PRODUCTION_SPRITES,
  collectAllCataloguedBuildingSpritePaths,
} from '@/catalog/buildingSprites';
import { Worker, WORKER_DEFS, type IdleAnim, inferHeldItemStyle } from '@/components/Worker';
import type { BuildingDefinition, ResourceType } from '@/types/GameData';
import {
  paintWorkerSpriteBody,
  paintWorkerFloorNap,
  paintDonkeySprite,
  WORKER_BODY_RESOURCE_SPRITE_PATHS,
} from '@/rendering/WorkerSpritePainter';
import { economySection, scheduleEconomyMermaid } from '@/debug/economySection';
import { createChimneySmoke, type ChimneySmoke } from '@/rendering/chimneySmoke';

const root = document.getElementById('catalog-root');
if (!root) throw new Error('#catalog-root missing');

const PREVIEW_MS_HOLD_COMPLETE = 2800;
const PREVIEW_MS_BUILD_STEP = 2000;
const PREVIEW_MS_PROD_STEP = 1200;

const ISO_TILE_W = 64;
const ISO_TILE_H = 32;
const SMOKE_CH = 250;
const GRID_CH = 260;

const spriteCache = new Map<string, HTMLImageElement>();

function preload(paths: string[]): void {
  for (const path of paths) {
    const img = new Image();
    img.src = path;
    spriteCache.set(path, img);
  }
}

function loadSprite(path: string): HTMLImageElement | null {
  let img = spriteCache.get(path);
  if (!img) {
    img = new Image();
    img.src = path;
    spriteCache.set(path, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

preload([...collectAllCataloguedBuildingSpritePaths(), ...WORKER_BODY_RESOURCE_SPRITE_PATHS]);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Stable fragment for `id` / href (building ids are already safe). */
function workerAnchorKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

function buildSectionToc(
  ariaLabel: string,
  items: readonly { id: string; label: string }[]
): HTMLElement {
  const nav = el('nav', 'catalog-section-toc');
  nav.setAttribute('aria-label', ariaLabel);
  for (const { id, label } of items) {
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.textContent = label;
    nav.appendChild(a);
  }
  return nav;
}

interface TimedFrame {
  path: string;
  caption: string;
  durationMs: number;
}

/** Construction / deconstruction only (no production sprites). */
function makeBuildTimeline(
  finalPath: string | undefined,
  buildStages: string[] | undefined
): TimedFrame[] {
  const out: TimedFrame[] = [];
  const add = (path: string, caption: string, durationMs: number): void => {
    out.push({ path, caption, durationMs });
  };

  if (buildStages?.length) {
    for (let i = 0; i < buildStages.length; i++) {
      add(
        buildStages[i]!,
        `Construct — stage ${i + 1} of ${buildStages.length}`,
        PREVIEW_MS_BUILD_STEP
      );
    }
    if (finalPath) add(finalPath, 'Completed', PREVIEW_MS_HOLD_COMPLETE);
  } else if (finalPath) {
    add(finalPath, 'Completed (no construction strip in catalogue)', PREVIEW_MS_HOLD_COMPLETE);
  }

  if (out.length === 0) {
    add('', 'No build / construction sprites in catalogue', 4000);
  }
  return out;
}

/** Working / production sprite cycle only; caller checks `prod.length`. */
function makeProductionTimeline(prod: string[]): TimedFrame[] {
  const out: TimedFrame[] = [];
  const add = (path: string, caption: string, durationMs: number): void => {
    out.push({ path, caption, durationMs });
  };
  const totalSlices = prod.length + 2;
  for (let rep = 0; rep < 2; rep++) {
    for (let slice = 0; slice < totalSlices; slice++) {
      const stageIndex = Math.min(slice, prod.length - 1);
      add(
        prod[stageIndex]!,
        `Production — step ${slice + 1} of ${totalSlices} (in-game cycle)`,
        PREVIEW_MS_PROD_STEP
      );
    }
  }
  return out;
}

function cycleDuration(timeline: TimedFrame[]): number {
  return timeline.reduce((a, f) => a + f.durationMs, 0);
}

function pickFrame(localMs: number, timeline: TimedFrame[]): TimedFrame {
  const c = cycleDuration(timeline);
  let m = localMs % c;
  for (const f of timeline) {
    if (m < f.durationMs) return f;
    m -= f.durationMs;
  }
  return timeline[timeline.length - 1]!;
}

interface BuildingAnimColumn {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  captionEl: HTMLElement;
  timeline: TimedFrame[];
  cw: number;
  ch: number;
}

interface SmokeAnimColumn {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  smoke: ChimneySmoke;
  finalPath: string | undefined;
  smokeOffsetX: number;
  smokeOffsetY: number;
  tileW: number;
  tileH: number;
  spriteScale: number;
  cw: number;
  ch: number;
}

interface GridPreviewColumn {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  finalPath: string | undefined;
  spriteScale: number;
  offsetX: number;
  offsetY: number;
  buildingW: number;
  buildingD: number;
  cw: number;
  ch: number;
}

interface BuildingPreviewRow {
  timeOffset: number;
  final: BuildingAnimColumn;
  build: BuildingAnimColumn;
  prod: BuildingAnimColumn | null;
  smoke: SmokeAnimColumn | null;
  gridPreview: GridPreviewColumn | null;
}

function tickAnimColumn(localMs: number, col: BuildingAnimColumn): void {
  const frame = pickFrame(localMs, col.timeline);
  col.captionEl.textContent = frame.caption;
  col.ctx.fillStyle = '#f0f0f0';
  col.ctx.fillRect(0, 0, col.cw, col.ch);
  if (!frame.path) return;
  const img = loadSprite(frame.path);
  if (!img) return;
  const scale = Math.min((col.cw * 0.94) / img.naturalWidth, (col.ch * 0.94) / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  col.ctx.drawImage(img, (col.cw - w) / 2, (col.ch - h) / 2, w, h);
}

function tickSmokeColumn(dt: number, col: SmokeAnimColumn): void {
  col.ctx.fillStyle = '#f0f0f0';
  col.ctx.fillRect(0, 0, col.cw, col.ch);

  const img = col.finalPath ? loadSprite(col.finalPath) : null;
  if (img) {
    const debugScale = Math.min(
      (col.cw * 0.88) / img.naturalWidth,
      (col.ch * 0.62) / img.naturalHeight
    );
    const debugDrawW = img.naturalWidth * debugScale;
    const debugDrawH = img.naturalHeight * debugScale;
    const BOTTOM_MARGIN = 8;
    col.ctx.drawImage(
      img,
      (col.cw - debugDrawW) / 2,
      col.ch - BOTTOM_MARGIN - debugDrawH,
      debugDrawW,
      debugDrawH
    );

    const footprintW = ((col.tileW + col.tileH) * ISO_TILE_W) / 2;
    const gameScaleEff = (footprintW / img.naturalWidth) * col.spriteScale;
    const scaleRatio = debugScale / gameScaleEff;
    const centerX = ((col.tileW - col.tileH) * ISO_TILE_W) / 4;
    const frontY = ((col.tileW + col.tileH) * ISO_TILE_H) / 2;

    const buildOriginX = col.cw / 2 - centerX * scaleRatio;
    const buildOriginY = col.ch - BOTTOM_MARGIN - frontY * scaleRatio;

    col.smoke.setPosition(
      buildOriginX + col.smokeOffsetX * scaleRatio,
      buildOriginY + col.smokeOffsetY * scaleRatio
    );
  }

  col.smoke.update(dt);
  col.smoke.draw(col.ctx);
}

function tickGridPreview(col: GridPreviewColumn): void {
  const { ctx, cw, ch } = col;
  const W = col.buildingW;
  const D = col.buildingD;

  // Zoom so the footprint occupies ~72% of canvas width, and leaves ~42% of canvas height
  // above the top-corner for the sprite art.
  const footprintPxW = ((W + D) * ISO_TILE_W) / 2;
  const footprintPxH = ((W + D) * ISO_TILE_H) / 2;
  const zoom = Math.min(
    (cw * 0.72) / Math.max(footprintPxW, 1),
    (ch * 0.4) / Math.max(footprintPxH, 1)
  );

  // centerX = horizontal center of the isometric diamond
  // frontY  = y of the front (bottom) corner of the diamond
  const centerX = ((W - D) * ISO_TILE_W) / 4;
  const frontY = ((W + D) * ISO_TILE_H) / 2;

  // Place so the footprint front sits at 82% of canvas height,
  // leaving 42% (= ch*0.82 - ch*0.40 = ch*0.42) above for the sprite.
  const canvasTopX = cw / 2 - centerX * zoom;
  const canvasTopY = ch * 0.82 - frontY * zoom;

  // Background
  ctx.fillStyle = '#dce8dc';
  ctx.fillRect(0, 0, cw, ch);

  // Draw isometric tile grid (W columns × D rows)
  for (let r = 0; r < D; r++) {
    for (let c = 0; c < W; c++) {
      // Top-vertex of each tile diamond in local game-pixel coords:
      //   x = (c - r) * tileW / 2,   y = (c + r) * tileH / 2
      const tx = canvasTopX + ((c - r) * ISO_TILE_W * zoom) / 2;
      const ty = canvasTopY + ((c + r) * ISO_TILE_H * zoom) / 2;
      const hw = (ISO_TILE_W * zoom) / 2;
      const hh = (ISO_TILE_H * zoom) / 2;

      ctx.beginPath();
      ctx.moveTo(tx, ty); // top vertex
      ctx.lineTo(tx + hw, ty + hh); // right vertex
      ctx.lineTo(tx, ty + hh * 2); // bottom vertex
      ctx.lineTo(tx - hw, ty + hh); // left vertex
      ctx.closePath();

      ctx.fillStyle = (c + r) % 2 === 0 ? '#c4d8b8' : '#b4c8a8';
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 110, 60, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Draw building sprite on top of the grid.
  // Replicates the exact game formula from RenderSystem.renderBuildingSprite.
  const img = col.finalPath ? loadSprite(col.finalPath) : null;
  if (img && img.naturalWidth > 0) {
    const footW = ((W + D) * ISO_TILE_W) / 2; // game footprint width (px)
    const baseScale = footW / img.naturalWidth; // sprite→footprint ratio
    const drawW = img.naturalWidth * baseScale * col.spriteScale;
    const drawH = img.naturalHeight * baseScale * col.spriteScale;

    // offsetX / offsetY shift the top-corner origin (matching the game's ctx.translate)
    const originX = canvasTopX + col.offsetX * zoom;
    const originY = canvasTopY + col.offsetY * zoom;

    ctx.drawImage(
      img,
      originX + centerX * zoom - (drawW * zoom) / 2,
      originY + frontY * zoom - drawH * zoom,
      drawW * zoom,
      drawH * zoom
    );
  } else if (!col.finalPath) {
    ctx.fillStyle = '#778877';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No sprite', cw / 2, ch / 2);
    ctx.textAlign = 'left';
  }
}

function resourceLabel(id: string): string {
  return dataManager.getResource(id as ResourceType)?.name ?? id;
}

function formatCostEntries(cost: Record<string, number> | undefined): string {
  if (!cost || Object.keys(cost).length === 0) return 'None';
  return Object.entries(cost)
    .map(([k, v]) => `${resourceLabel(k)} × ${v}`)
    .join(', ');
}

function formatProductionOutputs(outputs: Record<string, number> | undefined): string {
  if (!outputs || Object.keys(outputs).length === 0) return '—';
  return Object.entries(outputs)
    .map(([k, v]) => {
      const rd = dataManager.getResource(k as ResourceType);
      const tag = rd?.virtualOutput ? ' (virtual)' : '';
      return `${resourceLabel(k)} × ${v}${tag}`;
    })
    .join(', ');
}

function addDetailBlock(parent: HTMLElement, title: string): HTMLElement {
  const block = el('div', 'details-block');
  block.appendChild(el('h5', 'details-subheading', title));
  parent.appendChild(block);
  return block;
}

function addDetailLine(block: HTMLElement, label: string, value: string): void {
  const line = el('div', 'detail-line');
  const l = el('span', 'detail-label', `${label}:`);
  const v = el('span', 'detail-value', value);
  line.appendChild(l);
  line.appendChild(v);
  block.appendChild(line);
}

/** Economics / rules from `buildings.json` (via DataManager). */
function buildingDetailsPanel(def: BuildingDefinition): HTMLElement {
  const panel = el('div', 'col-details');

  let block = addDetailBlock(panel, 'Basics & placement');
  addDetailLine(block, 'Description', def.description);
  addDetailLine(
    block,
    'Category / tier',
    `${def.category}, tier ${def.tier}${def.plotType ? `, plot ${def.plotType}` : ''}`
  );
  addDetailLine(block, 'Footprint', `${def.size.width} × ${def.size.height} tiles`);
  addDetailLine(block, 'Requires road', def.requiresRoad ? 'Yes' : 'No');
  addDetailLine(block, 'Build time', `${def.buildTime}s`);
  addDetailLine(block, 'Build cost', formatCostEntries(def.buildCost));
  if (def.requiredTool) {
    addDetailLine(block, 'Required tool', resourceLabel(def.requiredTool));
  }

  block = addDetailBlock(panel, 'Population & staff');
  if (def.population?.provides != null) {
    addDetailLine(block, 'Housing', `+${def.population.provides} max population`);
  }
  if (def.population?.requires != null) {
    addDetailLine(block, 'Workers to operate', String(def.population.requires));
  }
  if (!def.population?.provides && !def.population?.requires) {
    addDetailLine(block, 'Population', '—');
  }

  if (def.storage) {
    block = addDetailBlock(panel, 'Storage');
    let cap = `${def.storage.capacity} total capacity`;
    if (def.storage.accepts?.length) {
      cap += `; accepts only: ${def.storage.accepts.map(resourceLabel).join(', ')}`;
    } else {
      cap += '; accepts all resource types';
    }
    addDetailLine(block, 'Warehouse rules', cap);
  }

  if (def.production) {
    const p = def.production;
    block = addDetailBlock(panel, 'Production');
    addDetailLine(
      block,
      'Cycle',
      `${p.productionTime}s per batch, ${p.continuous ? 'continuous' : 'one-shot'}`
    );
    addDetailLine(block, 'Outputs', formatProductionOutputs(p.outputs));
    if (p.inputs && Object.keys(p.inputs).length > 0) {
      addDetailLine(block, 'Inputs (recipe)', formatCostEntries(p.inputs));
    }
    if (p.inputsAny?.length) {
      const lines = p.inputsAny.map(
        g => `${g.amount} from any of: ${g.resourceTypes.map(resourceLabel).join(' / ')}`
      );
      addDetailLine(block, 'Inputs (OR groups)', lines.join('; '));
    }
    if (p.maxOutputBuffer != null)
      addDetailLine(block, 'Output buffer max', String(p.maxOutputBuffer));
    if (p.maxGatherRadius != null)
      addDetailLine(block, 'Gather radius (tiles)', String(p.maxGatherRadius));
    if (p.maxGatherWalkCells != null) {
      addDetailLine(block, 'Max gather walk (cells)', String(p.maxGatherWalkCells));
    }
    if (p.stonesPerRockTile != null) {
      addDetailLine(block, 'Stones per rock tile', String(p.stonesPerRockTile));
    }
    if (p.fishPerWaterTile != null) {
      addDetailLine(block, 'Fish per water tile', String(p.fishPerWaterTile));
    }
  }

  block = addDetailBlock(panel, 'Worker behaviour (data)');
  if (def.animation) {
    const pre = el('pre', 'detail-json', JSON.stringify(def.animation, null, 2));
    block.appendChild(pre);
  } else if (def.production && def.population?.requires) {
    addDetailLine(
      block,
      'Animation config',
      'Omitted in JSON — game synthesizes interior_operator at runtime when staffed + production exist.'
    );
  } else {
    addDetailLine(block, 'Animation config', '—');
  }

  block = addDetailBlock(panel, 'Flags & render hints');
  if (def.isHeadquarters) addDetailLine(block, 'Headquarters', 'Yes');
  if (def.canUpgrade) addDetailLine(block, 'Can upgrade to', def.canUpgrade);
  if (def.military) {
    addDetailLine(block, 'Soldier capacity', String(def.military.soldierCapacity));
  }
  addDetailLine(
    block,
    'Visual (iso)',
    `buildingHeight ${def.visual.buildingHeight}px, spriteScale ${def.visual.spriteScale ?? 1}, color ${def.visual.color}` +
      (def.visual.offsetX != null || def.visual.offsetY != null
        ? `, offset (${def.visual.offsetX ?? 0}, ${def.visual.offsetY ?? 0}) px`
        : '')
  );

  return panel;
}

/** Appends a smoke canvas to `colSmoke` and returns the live column object. */
function mountSmokeCanvas(
  colSmoke: HTMLElement,
  finalPath: string | undefined,
  def: BuildingDefinition,
  cfg: { offsetX: number; offsetY: number; density: number; shade: number }
): SmokeAnimColumn {
  const canvasWrap = el('div', 'row-canvas-wrap');
  const canvas = document.createElement('canvas');
  // CW / SMOKE_CH are module-level constants defined inside buildingSection;
  // use the same literal values here so the column matches.
  const CW = 360;
  canvas.width = CW;
  canvas.height = SMOKE_CH;
  const ctx = canvas.getContext('2d')!;
  canvasWrap.appendChild(canvas);
  colSmoke.appendChild(canvasWrap);

  const smoke = createChimneySmoke({
    x: CW / 2,
    y: SMOKE_CH / 2,
    density: cfg.density,
    shade: cfg.shade,
  });

  return {
    canvas,
    ctx,
    smoke,
    finalPath,
    smokeOffsetX: cfg.offsetX,
    smokeOffsetY: cfg.offsetY,
    tileW: def.size.width,
    tileH: def.size.height,
    spriteScale: def.visual.spriteScale ?? 1,
    cw: CW,
    ch: SMOKE_CH,
  };
}

/**
 * Appends an "Edit config" button + collapsible JSON editor panel to `colSmoke`.
 * Edits apply live to the running smoke preview; "Copy JSON" puts the object
 * on the clipboard so you can paste it into buildings.json.
 */
function attachSmokeEditor(
  colSmoke: HTMLElement,
  col: SmokeAnimColumn,
  autoOpen: boolean = false
): void {
  const editBtn = el('button', 'smoke-edit-btn', '✏ Edit config');

  const editorPanel = el('div', 'smoke-editor');
  const textarea = document.createElement('textarea');
  textarea.className = 'smoke-json-textarea';
  textarea.rows = 8;
  const errorEl = el('div', 'smoke-json-error');
  const actionsRow = el('div', 'smoke-editor-actions');
  const copyBtn = el('button', 'smoke-copy-btn', '📋 Copy JSON');
  actionsRow.appendChild(copyBtn);
  editorPanel.appendChild(textarea);
  editorPanel.appendChild(errorEl);
  editorPanel.appendChild(actionsRow);

  function serializeCfg(): string {
    return JSON.stringify(
      {
        offsetX: col.smokeOffsetX,
        offsetY: col.smokeOffsetY,
        density: Math.round(col.smoke.density * 100) / 100,
        shade: col.smoke.shade,
      },
      null,
      2
    );
  }

  function openEditor(): void {
    textarea.value = serializeCfg();
    errorEl.textContent = '';
    editorPanel.classList.add('open');
    editBtn.textContent = '✕ Close';
  }

  editBtn.addEventListener('click', () => {
    if (editorPanel.classList.contains('open')) {
      editorPanel.classList.remove('open');
      editBtn.textContent = '✏ Edit config';
    } else {
      openEditor();
    }
  });

  textarea.addEventListener('input', () => {
    try {
      const parsed: unknown = JSON.parse(textarea.value);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Expected a JSON object');
      const p = parsed as Record<string, unknown>;
      if (typeof p.offsetX === 'number') col.smokeOffsetX = p.offsetX;
      if (typeof p.offsetY === 'number') col.smokeOffsetY = p.offsetY;
      if (typeof p.density === 'number') col.smoke.setDensity(p.density);
      if (typeof p.shade === 'number') col.smoke.setShade(p.shade);
      errorEl.textContent = '';
    } catch (e) {
      errorEl.textContent = String(e);
    }
  });

  copyBtn.addEventListener('click', () => {
    const json = serializeCfg();
    navigator.clipboard.writeText(json).then(() => {
      copyBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copyBtn.textContent = '📋 Copy JSON';
      }, 2000);
    });
  });

  colSmoke.appendChild(editBtn);
  colSmoke.appendChild(editorPanel);

  if (autoOpen) openEditor();
}

/** Creates the grid preview canvas inside `colGrid` and returns the live column object. */
function mountGridPreviewCanvas(
  colGrid: HTMLElement,
  finalPath: string | undefined,
  def: BuildingDefinition,
  cfg: { spriteScale: number; offsetX: number; offsetY: number }
): GridPreviewColumn {
  const canvasWrap = el('div', 'row-canvas-wrap');
  const canvas = document.createElement('canvas');
  const GCW = 360;
  canvas.width = GCW;
  canvas.height = GRID_CH;
  const ctx = canvas.getContext('2d')!;
  canvasWrap.appendChild(canvas);
  colGrid.appendChild(canvasWrap);

  return {
    canvas,
    ctx,
    finalPath,
    spriteScale: cfg.spriteScale,
    offsetX: cfg.offsetX,
    offsetY: cfg.offsetY,
    buildingW: def.size.width,
    buildingD: def.size.height,
    cw: GCW,
    ch: GRID_CH,
  };
}

/**
 * Appends an "⋞ Edit visual" button + collapsible editor panel to `colGrid`.
 * Three number inputs control spriteScale / offsetX / offsetY live;
 * "⎘ Copy JSON" puts the snippet on the clipboard to paste into buildings.json.
 */
function attachGridEditor(
  colGrid: HTMLElement,
  col: GridPreviewColumn,
  autoOpen: boolean = false
): void {
  const editBtn = el('button', 'grid-edit-btn', '⋞ Edit visual');

  const editorPanel = el('div', 'grid-editor');
  const fieldsWrap = el('div', 'grid-editor-fields');

  function makeField(
    labelText: string,
    value: number,
    step: number,
    min?: number
  ): HTMLInputElement {
    const fieldRow = el('div', 'grid-editor-field');
    const label = el('label', '', labelText);
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.step = String(step);
    if (min !== undefined) input.min = String(min);
    fieldRow.appendChild(label);
    fieldRow.appendChild(input);
    fieldsWrap.appendChild(fieldRow);
    return input;
  }

  const scaleInput = makeField('spriteScale', col.spriteScale, 0.05, 0.05);
  const offsetXInput = makeField('offsetX', col.offsetX, 1);
  const offsetYInput = makeField('offsetY', col.offsetY, 1);

  scaleInput.addEventListener('input', () => {
    const v = parseFloat(scaleInput.value);
    if (!isNaN(v) && v > 0) col.spriteScale = v;
  });
  offsetXInput.addEventListener('input', () => {
    const v = parseFloat(offsetXInput.value);
    if (!isNaN(v)) col.offsetX = v;
  });
  offsetYInput.addEventListener('input', () => {
    const v = parseFloat(offsetYInput.value);
    if (!isNaN(v)) col.offsetY = v;
  });

  const actionsRow = el('div', 'smoke-editor-actions');
  const copyBtn = el('button', 'grid-copy-btn', '📋 Copy JSON');
  actionsRow.appendChild(copyBtn);

  editorPanel.appendChild(fieldsWrap);
  editorPanel.appendChild(actionsRow);

  copyBtn.addEventListener('click', () => {
    const snippet = JSON.stringify(
      {
        spriteScale: Math.round(col.spriteScale * 1000) / 1000,
        offsetX: col.offsetX,
        offsetY: col.offsetY,
      },
      null,
      2
    );
    navigator.clipboard.writeText(snippet).then(() => {
      copyBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copyBtn.textContent = '📋 Copy JSON';
      }, 2000);
    });
  });

  editBtn.addEventListener('click', () => {
    if (editorPanel.classList.contains('open')) {
      editorPanel.classList.remove('open');
      editBtn.textContent = '⋞ Edit visual';
    } else {
      editorPanel.classList.add('open');
      editBtn.textContent = '✕ Close';
    }
  });

  colGrid.appendChild(editBtn);
  colGrid.appendChild(editorPanel);

  if (autoOpen) {
    editorPanel.classList.add('open');
    editBtn.textContent = '✕ Close';
  }
}

function buildingSection(): HTMLElement {
  const wrap = el('div');
  wrap.id = 'section-buildings';
  wrap.appendChild(el('h2', '', 'Buildings'));

  const buildings = [...dataManager.getAllBuildings()].sort((a, b) => a.name.localeCompare(b.name));
  wrap.appendChild(
    buildSectionToc(
      'Jump to building',
      buildings.map(b => ({ id: `building-${b.id}`, label: b.name }))
    )
  );

  const previews: BuildingPreviewRow[] = [];
  const CW = 360;
  const CH = 168;

  for (let bi = 0; bi < buildings.length; bi++) {
    const def = buildings[bi]!;
    const id = def.id;
    const block = el('div', 'catalog-building-block');
    block.id = `building-${id}`;

    const head = el('div', 'catalog-building-head');
    head.appendChild(el('div', 'name', def.name));
    head.appendChild(el('div', 'id', id));
    block.appendChild(head);

    const colFinal = el('div', 'col-final');
    colFinal.appendChild(el('div', 'col-heading', 'Completed'));
    const finalPath = BUILDING_FINAL_SPRITES[id];
    const finalCanvasWrap = el('div', 'row-canvas-wrap');
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = CW;
    finalCanvas.height = CH;
    const finalCtx = finalCanvas.getContext('2d')!;
    finalCanvasWrap.appendChild(finalCanvas);
    colFinal.appendChild(finalCanvasWrap);
    const finalColumn: BuildingAnimColumn = {
      canvas: finalCanvas,
      ctx: finalCtx,
      captionEl: el('div'),
      timeline: finalPath
        ? [{ path: finalPath, caption: 'Completed', durationMs: 999_999_999 }]
        : [{ path: '', caption: 'No completed sprite', durationMs: 999_999_999 }],
      cw: CW,
      ch: CH,
    };

    const colBuild = el('div', 'col-build');
    colBuild.appendChild(el('div', 'col-heading', 'Construction'));
    const buildCanvasWrap = el('div', 'row-canvas-wrap');
    const buildCanvas = document.createElement('canvas');
    buildCanvas.width = CW;
    buildCanvas.height = CH;
    const buildCtx = buildCanvas.getContext('2d')!;
    buildCanvasWrap.appendChild(buildCanvas);
    colBuild.appendChild(buildCanvasWrap);
    const buildCaptionEl = el('div', 'stage-caption', '…');
    colBuild.appendChild(buildCaptionEl);

    const colProd = el('div', 'col-production');
    colProd.appendChild(el('div', 'col-heading', 'Production'));
    let prodColumn: BuildingAnimColumn | null = null;
    const prodSprites = BUILDING_PRODUCTION_SPRITES[id];
    if (prodSprites?.length) {
      const prodCanvasWrap = el('div', 'row-canvas-wrap');
      const prodCanvas = document.createElement('canvas');
      prodCanvas.width = CW;
      prodCanvas.height = CH;
      const prodCtx = prodCanvas.getContext('2d')!;
      prodCanvasWrap.appendChild(prodCanvas);
      colProd.appendChild(prodCanvasWrap);
      const prodCaptionEl = el('div', 'stage-caption', '…');
      colProd.appendChild(prodCaptionEl);
      prodColumn = {
        canvas: prodCanvas,
        ctx: prodCtx,
        captionEl: prodCaptionEl,
        timeline: makeProductionTimeline(prodSprites),
        cw: CW,
        ch: CH,
      };
    } else {
      colProd.appendChild(
        el(
          'div',
          'col-prod-placeholder',
          'No production sprites in catalogue — this column only animates when BUILDING_PRODUCTION_SPRITES has entries (e.g. farm).'
        )
      );
    }

    const smokeCfg = def.chimneySmoke;
    const colSmoke = el('div', 'col-smoke');
    colSmoke.appendChild(el('div', 'col-heading', 'Chimney Smoke'));

    const buildStages = BUILDING_CONSTRUCTION_SPRITES[id];
    const buildTimeline = makeBuildTimeline(finalPath, buildStages);
    const noSprites = !finalPath && !buildStages?.length && !prodSprites?.length;

    // Build the mutable row first so the "Add Smoke" closure can update row.smoke.
    const row: BuildingPreviewRow = {
      timeOffset: noSprites ? bi * 220 : bi * 240,
      final: finalColumn,
      build: {
        canvas: buildCanvas,
        ctx: buildCtx,
        captionEl: buildCaptionEl,
        timeline: noSprites
          ? [
              {
                path: '',
                caption: 'No catalogue sprites — game uses placeholder block.',
                durationMs: 10_000,
              },
            ]
          : buildTimeline,
        cw: CW,
        ch: CH,
      },
      prod: prodColumn,
      smoke: null,
      gridPreview: null,
    };

    if (smokeCfg) {
      // Building already has a chimneySmoke entry — mount canvas + live editor.
      const smokeCol = mountSmokeCanvas(colSmoke, finalPath, def, {
        offsetX: smokeCfg.offsetX,
        offsetY: smokeCfg.offsetY,
        density: smokeCfg.density ?? 1,
        shade: smokeCfg.shade ?? 3,
      });
      row.smoke = smokeCol;
      attachSmokeEditor(colSmoke, smokeCol);
    } else {
      // No smoke yet — show a placeholder with an "Add Smoke" button.
      const noCfg = el('div', 'smoke-no-cfg');
      noCfg.appendChild(el('span', '', 'No chimneySmoke config in buildings.json.'));
      const addBtn = el('button', 'smoke-add-btn', '+ Add Smoke');
      noCfg.appendChild(addBtn);
      colSmoke.appendChild(noCfg);

      addBtn.addEventListener('click', () => {
        noCfg.remove();
        const smokeCol = mountSmokeCanvas(colSmoke, finalPath, def, {
          offsetX: 0,
          offsetY: -30,
          density: 1,
          shade: 3,
        });
        row.smoke = smokeCol;
        // Auto-open the editor so the user can start tweaking immediately.
        attachSmokeEditor(colSmoke, smokeCol, true);
      });
    }

    // Grid preview column — shows sprite on top of the isometric tile grid
    const colGrid = el('div', 'col-grid-preview');
    colGrid.appendChild(el('div', 'col-heading', 'Grid Preview'));
    const gridCol = mountGridPreviewCanvas(colGrid, finalPath, def, {
      spriteScale: def.visual.spriteScale ?? 1,
      offsetX: def.visual.offsetX ?? 0,
      offsetY: def.visual.offsetY ?? 0,
    });
    attachGridEditor(colGrid, gridCol);
    row.gridPreview = gridCol;

    const colData = buildingDetailsPanel(def);

    // Row 1 — all visual columns side by side
    const visualRow = el('div', 'catalog-building-visual-row');
    visualRow.appendChild(colFinal);
    visualRow.appendChild(colBuild);
    visualRow.appendChild(colProd);
    visualRow.appendChild(colSmoke);
    visualRow.appendChild(colGrid);
    block.appendChild(visualRow);

    // Row 2 — details panel spanning full width (multi-column via CSS grid)
    const detailsRow = el('div', 'catalog-building-details-row');
    detailsRow.appendChild(colData);
    block.appendChild(detailsRow);
    wrap.appendChild(block);

    previews.push(row);
  }

  let prevNow = performance.now();
  const t0 = performance.now();
  function tick(now: number): void {
    const dt = Math.min((now - prevNow) / 1000, 0.1);
    prevNow = now;
    const t = now - t0;
    for (const row of previews) {
      tickAnimColumn(t + row.timeOffset, row.final);
      tickAnimColumn(t + row.timeOffset, row.build);
      if (row.prod) tickAnimColumn(t + row.timeOffset, row.prod);
      if (row.smoke) tickSmokeColumn(dt, row.smoke);
      if (row.gridPreview) tickGridPreview(row.gridPreview);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return wrap;
}

function basePatch(
  now: number,
  overrides: Partial<{
    isMoving: boolean;
    frame: number;
    facing: number;
    anim: IdleAnim;
    animT: number;
    isCarrying: boolean;
    isHammerConstruct: boolean;
    isPlantDigging: boolean;
    isFisherFishing: boolean;
    isStoneGathering: boolean;
    isSideCarryTool: boolean;
    isOverheadCarry: boolean;
    armAnim: IdleAnim;
  }>
) {
  const isMoving = overrides.isMoving ?? false;
  const frame = overrides.frame ?? (isMoving ? Math.floor(now / 200) % 4 : 0);
  const facing = overrides.facing ?? 0;
  const anim = overrides.anim ?? 'none';
  const animT = overrides.animT ?? 0;
  const isCarrying = overrides.isCarrying ?? false;
  return {
    isMoving,
    frame,
    facing,
    anim,
    animT,
    isCarrying,
    isHammerConstruct: overrides.isHammerConstruct ?? false,
    isPlantDigging: overrides.isPlantDigging ?? false,
    isFisherFishing: overrides.isFisherFishing ?? false,
    isStoneGathering: overrides.isStoneGathering ?? false,
    isSideCarryTool: overrides.isSideCarryTool ?? false,
    isOverheadCarry: overrides.isOverheadCarry ?? false,
    armAnim: overrides.armAnim ?? anim,
    s: 3.15,
  };
}

type WorkerPreviewEntry =
  | { kind: 'normal'; worker: Worker; patch: (now: number) => ReturnType<typeof basePatch> }
  | { kind: 'nap'; worker: Worker }
  | {
      kind: 'donkey';
      patch: (now: number) => ReturnType<typeof basePatch>;
      carriedItems: Array<{ resourceType: string }>;
    }
  | { kind: 'duel'; workerA: Worker; workerB: Worker; s: number };

function workerSection(): HTMLElement {
  const wrap = el('div');
  wrap.id = 'section-workers';
  wrap.appendChild(el('h2', '', 'Workers (procedural canvas)'));

  const workerToc: { id: string; label: string }[] = [];

  const intro = el(
    'p',
    'sub',
    'Peasant + military roles: clothing variants, walk, idle poses, job carries, floor nap, and soldier ranks. Drawing matches the main game (shared painter).'
  );
  intro.style.marginBottom = '16px';

  const grid = el('div', 'worker-preview-grid');
  const previews: WorkerPreviewEntry[] = [];
  const W = 228;
  const H = 212;

  function addCard(anchorKey: string, caption: string, entry: WorkerPreviewEntry): void {
    const id = `worker-${workerAnchorKey(anchorKey)}`;
    workerToc.push({ id, label: caption });

    const card = el('div', 'worker-preview-card');
    card.id = id;

    const canvasWrap = el('div', 'worker-preview-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvasWrap.appendChild(canvas);

    card.appendChild(canvasWrap);
    card.appendChild(el('div', 'worker-preview-name', caption));
    grid.appendChild(card);
    previews.push(entry);
  }

  const variants = WORKER_DEFS.peasant.variants;
  variants.forEach((appearance, i) => {
    const w = new Worker(`Variant ${i + 1}`, 'peasant');
    Object.assign(w.appearance, appearance);
    addCard(`clothing-${appearance.variant}`, `Clothing: ${appearance.variant}`, {
      kind: 'normal',
      worker: w,
      patch: now => basePatch(now, { facing: 0, anim: 'none', animT: 0 }),
    });
  });

  const walk = new Worker('Walk', 'peasant');
  addCard('walk-se', 'Walk (facing SE)', {
    kind: 'normal',
    worker: walk,
    patch: now => basePatch(now, { isMoving: true, facing: 0 }),
  });

  const idles: IdleAnim[] = ['look_around', 'scratch_head', 'hands_on_hips', 'stretch', 'read'];
  for (const anim of idles) {
    const w = new Worker(`Idle:${anim}`, 'peasant');
    const duration = 2400;
    addCard(`idle-${anim}`, `Idle: ${anim}`, {
      kind: 'normal',
      worker: w,
      patch: now => {
        const t = (now % duration) / duration;
        return basePatch(now, { anim, animT: t, facing: 0 });
      },
    });
  }

  const nap = new Worker('Nap', 'peasant');
  nap.state = 'idle';
  nap.idleFacing = 0;
  nap.floorSleepStartedAtMs = performance.now();
  nap.floorSleepUntilMs = Number.MAX_SAFE_INTEGER;
  addCard('nap', 'Floor nap (sleep)', { kind: 'nap', worker: nap });

  const hammer = new Worker('Hammer', 'peasant');
  hammer.carryingResource = 'hammer';
  hammer.heldItemStyle = inferHeldItemStyle('hammer');
  hammer.visualActivity = 'construct';
  hammer.hammerConstructionEnabled = true;
  hammer.state = 'working';
  addCard('hammer', 'Construct (hammer)', {
    kind: 'normal',
    worker: hammer,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isHammerConstruct: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const dig = new Worker('Dig', 'peasant');
  dig.carryingResource = 'shovel';
  dig.heldItemStyle = inferHeldItemStyle('shovel');
  dig.visualActivity = 'production_plant';
  dig.state = 'working';
  addCard('shovel', 'Shovel (plant / dig)', {
    kind: 'normal',
    worker: dig,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isPlantDigging: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const pick = new Worker('Pick', 'peasant');
  pick.carryingResource = 'pickaxe';
  pick.heldItemStyle = inferHeldItemStyle('pickaxe');
  pick.visualActivity = 'production_gather';
  pick.state = 'working';
  addCard('pickaxe', 'Pickaxe (gather)', {
    kind: 'normal',
    worker: pick,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isStoneGathering: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const fisher = new Worker('Fisher', 'peasant');
  fisher.carryingResource = 'fishing_rod';
  fisher.heldItemStyle = inferHeldItemStyle('fishing_rod');
  fisher.visualActivity = 'production_gather';
  fisher.state = 'working';
  addCard('fishing-rod', 'Fishing (shore sit)', {
    kind: 'normal',
    worker: fisher,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isFisherFishing: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const axe = new Worker('Axe', 'peasant');
  axe.carryingResource = 'axe';
  axe.heldItemStyle = inferHeldItemStyle('axe');
  axe.visualActivity = 'general';
  axe.state = 'walking';
  addCard('axe-walk', 'Side carry: axe + walk', {
    kind: 'normal',
    worker: axe,
    patch: now =>
      basePatch(now, {
        isMoving: true,
        facing: 1,
        isCarrying: true,
        isSideCarryTool: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const log = new Worker('Log', 'peasant');
  log.carryingResource = 'wood_log';
  log.heldItemStyle = inferHeldItemStyle('wood_log');
  log.state = 'carrying';
  addCard('carry-log', 'Overhead: wood log', {
    kind: 'normal',
    worker: log,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isOverheadCarry: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const well = new Worker('Well', 'peasant');
  well.carryingResource = 'water';
  well.heldItemStyle = inferHeldItemStyle('water');
  well.visualActivity = 'production_well';
  well.state = 'working';
  addCard('well-water', 'Well (water)', {
    kind: 'normal',
    worker: well,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isOverheadCarry: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  const mill = new Worker('Mill', 'peasant');
  mill.carryingResource = 'flour';
  mill.heldItemStyle = inferHeldItemStyle('flour');
  mill.visualActivity = 'production_mill';
  mill.state = 'working';
  addCard('mill-flour', 'Mill (flour)', {
    kind: 'normal',
    worker: mill,
    patch: now =>
      basePatch(now, {
        isCarrying: true,
        isOverheadCarry: true,
        anim: 'none',
        armAnim: 'none',
      }),
  });

  // — Donkey carrier —
  addCard('donkey-idle', 'Donkey — idle', {
    kind: 'donkey',
    patch: now => basePatch(now, { facing: 0 }),
    carriedItems: [],
  });
  addCard('donkey-walk', 'Donkey — walking', {
    kind: 'donkey',
    patch: now => basePatch(now, { isMoving: true, facing: 0 }),
    carriedItems: [],
  });
  addCard('donkey-loaded', 'Donkey — loaded + walking', {
    kind: 'donkey',
    patch: now => basePatch(now, { isMoving: true, facing: 0 }),
    carriedItems: [
      { resourceType: 'wood_log' },
      { resourceType: 'wood_plank' },
      { resourceType: 'stone' },
    ],
  });

  const soldierR1 = new Worker('Soldier R1', 'military');
  soldierR1.applyMilitaryAppearance(1);
  addCard('military-rank-1', 'Military rank 1 (sword + shield)', {
    kind: 'normal',
    worker: soldierR1,
    patch: now => basePatch(now, { isMoving: true, facing: 0, anim: 'none', armAnim: 'none' }),
  });

  const soldierR2 = new Worker('Soldier R2', 'military');
  soldierR2.applyMilitaryAppearance(2);
  addCard('military-rank-2', 'Military rank 2 (helmet)', {
    kind: 'normal',
    worker: soldierR2,
    patch: now => basePatch(now, { facing: 0, anim: 'none' }),
  });

  const soldierR3 = new Worker('Soldier R3', 'military');
  soldierR3.applyMilitaryAppearance(3);
  addCard('military-rank-3', 'Military rank 3 (gold trim)', {
    kind: 'normal',
    worker: soldierR3,
    patch: now => basePatch(now, { facing: 0, anim: 'none' }),
  });

  // — Military fighting (duel) —
  // Each card shows a player soldier (left) vs a red-tinted enemy (right) mid-duel.
  // The sword-swing + body-bob animation is driven entirely by `now` inside paintMilitaryWarrior
  // when visualActivity === 'combat_duel', so no extra frame logic is needed here.
  for (let rank = 1; rank <= 3; rank++) {
    const r = rank as 1 | 2 | 3;
    const wa = new Worker(`Duel A R${rank}`, 'military');
    wa.applyMilitaryAppearance(r);
    wa.visualActivity = 'combat_duel';
    const wb = new Worker(`Duel B R${rank}`, 'military');
    wb.applyMilitaryAppearance(r);
    wb.visualActivity = 'combat_duel';
    addCard(`military-duel-rank-${rank}`, `Military R${rank} — fighting`, {
      kind: 'duel',
      workerA: wa,
      workerB: wb,
      s: 3.15,
    });
  }

  wrap.appendChild(buildSectionToc('Jump to worker preview', workerToc));
  wrap.appendChild(intro);
  wrap.appendChild(grid);

  function frame(now: number): void {
    for (let i = 0; i < previews.length; i++) {
      const entry = previews[i]!;
      const card = grid.children[i] as HTMLElement | undefined;
      const canvas = card?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) continue;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, W, H);

      if (entry.kind === 'donkey') {
        const o = entry.patch(now);
        ctx.save();
        ctx.translate(W / 2, H - 20);
        paintDonkeySprite(ctx, loadSprite, o.s, o.facing, o.isMoving, o.frame, entry.carriedItems);
        ctx.restore();
        continue;
      }

      if (entry.kind === 'duel') {
        // Two soldiers facing each other; sword-wobble is sin(now/145) inside the painter.
        const duelFrame = Math.floor(now / 120) % 4;
        const paintDuelSoldier = (worker: Worker, facing: number, enemyTint: boolean) => {
          paintWorkerSpriteBody(ctx, loadSprite, {
            worker,
            s: entry.s,
            facing,
            isMoving: true,
            frame: duelFrame,
            now,
            anim: 'none',
            animT: 0,
            isCarrying: false,
            isHammerConstruct: false,
            isPlantDigging: false,
            isFisherFishing: false,
            isStoneGathering: false,
            isSideCarryTool: false,
            isOverheadCarry: false,
            armAnim: 'none',
            drawRoundFootShadow: true,
            napPillowArms: false,
            enemyTint,
          });
        };
        // Player: left side, faces right (facing=0)
        ctx.save();
        ctx.translate(W / 2 - 26, H - 20);
        paintDuelSoldier(entry.workerA, 0, false);
        ctx.restore();
        // Enemy: right side, faces left (facing=1 = mirrored)
        ctx.save();
        ctx.translate(W / 2 + 26, H - 20);
        paintDuelSoldier(entry.workerB, 1, true);
        ctx.restore();
        continue;
      }

      if (entry.kind === 'nap') {
        ctx.save();
        ctx.translate(W / 2, H - 20);
        paintWorkerFloorNap(ctx, loadSprite, entry.worker, now, 3.15, entry.worker.idleFacing);
        ctx.restore();
        continue;
      }

      const o = entry.patch(now);
      ctx.save();
      ctx.translate(W / 2, H - 20);
      paintWorkerSpriteBody(ctx, loadSprite, {
        worker: entry.worker,
        s: o.s,
        facing: o.facing,
        isMoving: o.isMoving,
        frame: o.frame,
        now,
        anim: o.anim,
        animT: o.animT,
        isCarrying: o.isCarrying,
        isHammerConstruct: o.isHammerConstruct,
        isPlantDigging: o.isPlantDigging,
        isFisherFishing: o.isFisherFishing,
        isStoneGathering: o.isStoneGathering,
        isSideCarryTool: o.isSideCarryTool,
        isOverheadCarry: o.isOverheadCarry,
        armAnim: o.armAnim,
        drawRoundFootShadow: true,
        napPillowArms: false,
      });
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return wrap;
}

root.appendChild(buildingSection());
root.appendChild(workerSection());
root.appendChild(economySection());
scheduleEconomyMermaid();
