import type { TileMap } from '@/map/TileMap';
import { dataManager } from '@/data/DataManager';
import type { BuildingType } from '@/types/GameData';

export type EnemyVillageBuildingPlan = {
  type: BuildingType;
  x: number;
  y: number;
  seedGarrison?: boolean;
};

export type EnemyVillagePlan = {
  id: string;
  factionId: 'enemy_1';
  bounds: { x: number; y: number; width: number; height: number };
  headquarters: EnemyVillageBuildingPlan;
  buildings: EnemyVillageBuildingPlan[];
  roads: { x: number; y: number }[];
  waterCells: { x: number; y: number }[];
  revealCells: { x: number; y: number }[];
};

const VILLAGE_SIZE = 28;
const EXTRA_SLOTS: Array<{ x: number; y: number }> = [
  { x: 6, y: 7 },
  { x: 19, y: 7 },
  { x: 5, y: 20 },
  { x: 19, y: 21 },
  { x: 2, y: 13 },
  { x: 22, y: 14 },
  { x: 11, y: 23 },
  { x: 12, y: 3 },
];

const EXTRA_TYPES: BuildingType[] = [
  'hut',
  'house',
  'lumberjack',
  'quarry',
  'well',
  'hunter',
];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function rectCells(x: number, y: number, width: number, height: number): string[] {
  const cells: string[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) cells.push(key(x + dx, y + dy));
  }
  return cells;
}

function getEntranceRoadCell(plan: EnemyVillageBuildingPlan, occupied: ReadonlySet<string>): { x: number; y: number } {
  const def = dataManager.getBuilding(plan.type)!;
  const ex = plan.x + def.size.width - 1;
  const ey = plan.y + Math.ceil((def.size.height - 1) / 2);
  const candidates = [
    { x: ex + 1, y: ey },
    { x: ex, y: ey + 1 },
    { x: ex, y: ey - 1 },
    { x: ex - 1, y: ey },
  ];
  return candidates.find(c => !occupied.has(key(c.x, c.y))) ?? candidates[0];
}

function addRoadPath(
  out: Map<string, { x: number; y: number }>,
  occupied: ReadonlySet<string>,
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number }
): void {
  const minX = bounds.x - 1;
  const maxX = bounds.x + bounds.width;
  const minY = bounds.y - 1;
  const maxY = bounds.y + bounds.height;
  const startKey = key(a.x, a.y);
  const goalKey = key(b.x, b.y);
  const queue = [a];
  const cameFrom = new Map<string, string | null>([[startKey, null]]);
  const dirs: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0 && !cameFrom.has(goalKey)) {
    const cur = queue.shift()!;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const nk = key(nx, ny);
      if (cameFrom.has(nk)) continue;
      if (occupied.has(nk)) continue;
      cameFrom.set(nk, key(cur.x, cur.y));
      queue.push({ x: nx, y: ny });
    }
  }

  if (!cameFrom.has(goalKey)) return;
  let cur: string | null = goalKey;
  while (cur) {
    const [x, y] = cur.split(',').map(Number);
    out.set(cur, { x, y });
    cur = cameFrom.get(cur) ?? null;
  }
}

function areaHasOccupiedTile(tileMap: TileMap, x: number, y: number, size: number): boolean {
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      if (tileMap.getTile(x + dx, y + dy)?.isOccupied()) return true;
    }
  }
  return false;
}

export function planInitialEnemyVillage(tileMap: TileMap, playerCenter: { x: number; y: number }): EnemyVillagePlan | null {
  const initialRadius = dataManager.getGameConfig().starting.exploration.initialRadius;
  const offset = initialRadius + 4;
  const candidates = [
    { x: playerCenter.x + offset, y: playerCenter.y - Math.floor(VILLAGE_SIZE / 2) },
    { x: playerCenter.x - offset - VILLAGE_SIZE, y: playerCenter.y - Math.floor(VILLAGE_SIZE / 2) },
    { x: playerCenter.x - Math.floor(VILLAGE_SIZE / 2), y: playerCenter.y + offset },
    { x: playerCenter.x - Math.floor(VILLAGE_SIZE / 2), y: playerCenter.y - offset - VILLAGE_SIZE },
  ];

  const bounds = candidates.find(c =>
    c.x >= 2 &&
    c.y >= 2 &&
    c.x + VILLAGE_SIZE < tileMap.width - 2 &&
    c.y + VILLAGE_SIZE < tileMap.height - 2 &&
    !areaHasOccupiedTile(tileMap, c.x, c.y, VILLAGE_SIZE)
  );
  if (!bounds) return null;

  const random = mulberry32(tileMap.getSeed() ^ 0xC0FFEE);
  const headquarters: EnemyVillageBuildingPlan = {
    type: 'base_camp',
    x: bounds.x + 10,
    y: bounds.y + 10,
  };
  const buildings: EnemyVillageBuildingPlan[] = [
    { type: 'guardhouse', x: bounds.x + 4, y: bounds.y + 13, seedGarrison: true },
    { type: 'watchtower', x: bounds.x + 12, y: bounds.y + 3, seedGarrison: true },
    { type: 'barracks', x: bounds.x + 21, y: bounds.y + 15, seedGarrison: true },
    { type: 'forester', x: bounds.x + 4, y: bounds.y + 5 },
    { type: 'farm', x: bounds.x + 17, y: bounds.y + 5 },
    { type: 'fisher', x: bounds.x + 8, y: bounds.y + 22 },
  ];
  const waterCells = [
    { x: bounds.x + 4, y: bounds.y + 23 },
    { x: bounds.x + 5, y: bounds.y + 23 },
    { x: bounds.x + 4, y: bounds.y + 24 },
    { x: bounds.x + 5, y: bounds.y + 24 },
    { x: bounds.x + 6, y: bounds.y + 24 },
  ];

  const extraCount = Math.floor(random() * 9);
  const shuffledSlots = [...EXTRA_SLOTS].sort(() => random() - 0.5);
  const shuffledTypes = [...EXTRA_TYPES].sort(() => random() - 0.5);
  const occupied = new Set<string>();
  for (const plan of [headquarters, ...buildings]) {
    const def = dataManager.getBuilding(plan.type)!;
    for (const cell of rectCells(plan.x, plan.y, def.size.width, def.size.height)) occupied.add(cell);
  }
  for (const cell of waterCells) occupied.add(key(cell.x, cell.y));

  for (let i = 0; i < extraCount && i < shuffledSlots.length; i++) {
    const type = shuffledTypes[i % shuffledTypes.length];
    const def = dataManager.getBuilding(type);
    const slot = shuffledSlots[i];
    if (!def) continue;
    const plan = { type, x: bounds.x + slot.x, y: bounds.y + slot.y };
    const cells = rectCells(plan.x, plan.y, def.size.width, def.size.height);
    if (cells.some(c => occupied.has(c))) continue;
    for (const cell of cells) occupied.add(cell);
    buildings.push(plan);
  }

  const roads = new Map<string, { x: number; y: number }>();
  const hqRoad = getEntranceRoadCell(headquarters, occupied);
  roads.set(key(hqRoad.x, hqRoad.y), hqRoad);
  for (const building of buildings) {
    const road = getEntranceRoadCell(building, occupied);
    addRoadPath(roads, occupied, hqRoad, road, { ...bounds, width: VILLAGE_SIZE, height: VILLAGE_SIZE });
  }

  const military = buildings.filter(b => b.seedGarrison);
  const nearestMilitary = military.reduce((best, cur) => {
    const curDef = dataManager.getBuilding(cur.type)!;
    const bestDef = dataManager.getBuilding(best.type)!;
    const curCx = cur.x + Math.floor(curDef.size.width / 2);
    const curCy = cur.y + Math.floor(curDef.size.height / 2);
    const bestCx = best.x + Math.floor(bestDef.size.width / 2);
    const bestCy = best.y + Math.floor(bestDef.size.height / 2);
    const curD = Math.abs(curCx - playerCenter.x) + Math.abs(curCy - playerCenter.y);
    const bestD = Math.abs(bestCx - playerCenter.x) + Math.abs(bestCy - playerCenter.y);
    return curD < bestD ? cur : best;
  }, military[0]!);
  const nearestDef = dataManager.getBuilding(nearestMilitary.type)!;
  const revealCx = nearestMilitary.x + Math.floor(nearestDef.size.width / 2);
  const revealCy = nearestMilitary.y + Math.floor(nearestDef.size.height / 2);
  const revealCells: { x: number; y: number }[] = [];
  for (let y = revealCy - 7; y <= revealCy + 7; y++) {
    for (let x = revealCx - 7; x <= revealCx + 7; x++) {
      if (tileMap.isInBounds(x, y) && Math.max(Math.abs(x - revealCx), Math.abs(y - revealCy)) <= 7) {
        revealCells.push({ x, y });
      }
    }
  }

  return {
    id: 'enemy_1_initial_village',
    factionId: 'enemy_1',
    bounds: { ...bounds, width: VILLAGE_SIZE, height: VILLAGE_SIZE },
    headquarters,
    buildings,
    roads: [...roads.values()],
    waterCells,
    revealCells,
  };
}
