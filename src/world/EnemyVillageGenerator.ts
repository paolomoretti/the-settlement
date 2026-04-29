import type { TileMap } from '@/map/TileMap';
import type { EnemyFactionId } from '@/components/Owner';
import { ENEMY_FACTIONS } from '@/components/ownerUtils';
import { dataManager } from '@/data/DataManager';
import type { BuildingType } from '@/types/GameData';

export type EnemyVillageBuildingPlan = {
  type: BuildingType;
  x: number;
  y: number;
  seedGarrison?: boolean;
  garrisonFillRatio?: number;
  garrisonRank?: 1 | 2 | 3;
};

export type EnemyVillagePlan = {
  id: string;
  factionId: EnemyFactionId;
  difficulty: number;
  aggressivenessLevel: number;
  activated?: boolean;
  nextAttackAt?: number;
  lastReinforcedAt?: number;
  bounds: { x: number; y: number; width: number; height: number };
  headquarters: EnemyVillageBuildingPlan;
  buildings: EnemyVillageBuildingPlan[];
  roads: { x: number; y: number }[];
  waterCells: { x: number; y: number }[];
  revealCells: { x: number; y: number }[];
};

const CIVILIAN_TYPES: BuildingType[] = [
  'hut',
  'house',
  'lumberjack',
  'sawmill',
  'forester',
  'quarry',
  'well',
  'farm',
  'mill',
  'bakery',
  'hunter',
  'fisher',
];

const EARLY_MILITARY_TYPES: BuildingType[] = ['barracks', 'guardhouse'];
const MID_MILITARY_TYPES: BuildingType[] = ['barracks', 'guardhouse', 'watchtower'];
const LATE_MILITARY_TYPES: BuildingType[] = ['guardhouse', 'watchtower', 'fortress'];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
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

function centerOf(plan: EnemyVillageBuildingPlan): { x: number; y: number } {
  const def = dataManager.getBuilding(plan.type)!;
  return {
    x: plan.x + Math.floor(def.size.width / 2),
    y: plan.y + Math.floor(def.size.height / 2),
  };
}

function getEntranceRoadCell(
  plan: EnemyVillageBuildingPlan,
  occupied: ReadonlySet<string>
): { x: number; y: number } {
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

function areaHasOccupiedTile(
  tileMap: TileMap,
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (tileMap.getTile(x + dx, y + dy)?.isOccupied()) return true;
    }
  }
  return false;
}

function overlapsExistingBounds(
  candidate: { x: number; y: number; width: number; height: number },
  existing: readonly { x: number; y: number; width: number; height: number }[]
): boolean {
  const { minSpacingBetweenVillages } = dataManager.getGameConfig().enemyRealms;
  return existing.some(
    bounds =>
      candidate.x < bounds.x + bounds.width + minSpacingBetweenVillages &&
      candidate.x + candidate.width + minSpacingBetweenVillages > bounds.x &&
      candidate.y < bounds.y + bounds.height + minSpacingBetweenVillages &&
      candidate.y + candidate.height + minSpacingBetweenVillages > bounds.y
  );
}

function createSlotGrid(
  bounds: { x: number; y: number; width: number; height: number },
  random: () => number
): Array<{ x: number; y: number }> {
  const slots: Array<{ x: number; y: number }> = [];
  for (let y = bounds.y + 3; y <= bounds.y + bounds.height - 6; y += 5) {
    for (let x = bounds.x + 3; x <= bounds.x + bounds.width - 6; x += 5) {
      const jitterX = Math.floor(random() * 3) - 1;
      const jitterY = Math.floor(random() * 3) - 1;
      slots.push({ x: x + jitterX, y: y + jitterY });
    }
  }
  return slots.sort(() => random() - 0.5);
}

function chooseMilitaryTypes(difficulty: number, count: number): BuildingType[] {
  const pool =
    difficulty >= 7
      ? LATE_MILITARY_TYPES
      : difficulty >= 3
        ? MID_MILITARY_TYPES
        : EARLY_MILITARY_TYPES;
  const out: BuildingType[] = [];
  for (let i = 0; i < count; i++) {
    if (difficulty >= 6 && i % 4 === 0) out.push('fortress');
    else out.push(pool[(i + difficulty) % pool.length]!);
  }
  return out;
}

function tryPlaceBuilding(
  out: EnemyVillageBuildingPlan[],
  occupied: Set<string>,
  type: BuildingType,
  slot: { x: number; y: number },
  extra?: Pick<EnemyVillageBuildingPlan, 'seedGarrison' | 'garrisonFillRatio' | 'garrisonRank'>
): boolean {
  const def = dataManager.getBuilding(type);
  if (!def) return false;
  const plan: EnemyVillageBuildingPlan = { type, x: slot.x, y: slot.y, ...extra };
  const cells = rectCells(plan.x, plan.y, def.size.width, def.size.height);
  if (cells.some(c => occupied.has(c))) return false;
  for (const cell of cells) occupied.add(cell);
  out.push(plan);
  return true;
}

function findVillageBounds(
  tileMap: TileMap,
  playerCenter: { x: number; y: number },
  size: number,
  villageIndex: number,
  existing: readonly { x: number; y: number; width: number; height: number }[]
): { x: number; y: number; width: number; height: number } | null {
  const initialRadius = dataManager.getGameConfig().starting.exploration.initialRadius;
  const margin = 2;
  const candidates: Array<{ x: number; y: number; width: number; height: number }> = [];

  if (villageIndex === 0) {
    const offset = initialRadius + 4;
    candidates.push(
      {
        x: playerCenter.x + offset,
        y: playerCenter.y - Math.floor(size / 2),
        width: size,
        height: size,
      },
      {
        x: playerCenter.x - offset - size,
        y: playerCenter.y - Math.floor(size / 2),
        width: size,
        height: size,
      },
      {
        x: playerCenter.x - Math.floor(size / 2),
        y: playerCenter.y + offset,
        width: size,
        height: size,
      },
      {
        x: playerCenter.x - Math.floor(size / 2),
        y: playerCenter.y - offset - size,
        width: size,
        height: size,
      }
    );
  } else {
    const maxRadius = Math.min(tileMap.width, tileMap.height) * 0.46;
    const minRadius = initialRadius + 80;
    const villageCount = Math.max(1, dataManager.getGameConfig().enemyRealms.villageCount);
    const radius =
      minRadius + ((maxRadius - minRadius) * villageIndex) / Math.max(1, villageCount - 1);
    const baseAngle = -Math.PI / 3 + villageIndex * 2.399963229728653;
    for (let ring = 0; ring < 5; ring++) {
      for (let step = 0; step < 10; step++) {
        const angle = baseAngle + step * ((Math.PI * 2) / 10) + ring * 0.19;
        const r = radius + (ring - 2) * 34;
        const cx = Math.round(playerCenter.x + Math.cos(angle) * r);
        const cy = Math.round(playerCenter.y + Math.sin(angle) * r);
        candidates.push({
          x: cx - Math.floor(size / 2),
          y: cy - Math.floor(size / 2),
          width: size,
          height: size,
        });
      }
    }
  }

  return (
    candidates.find(
      c =>
        c.x >= margin &&
        c.y >= margin &&
        c.x + c.width < tileMap.width - margin &&
        c.y + c.height < tileMap.height - margin &&
        !overlapsExistingBounds(c, existing) &&
        !areaHasOccupiedTile(tileMap, c.x, c.y, c.width, c.height)
    ) ?? null
  );
}

function planEnemyVillage(
  tileMap: TileMap,
  playerCenter: { x: number; y: number },
  villageIndex: number,
  existingBounds: readonly { x: number; y: number; width: number; height: number }[]
): EnemyVillagePlan | null {
  const realmConfig = dataManager.getGameConfig().enemyRealms;
  const difficulty = villageIndex;
  const size = Math.min(realmConfig.maxVillageSize, realmConfig.minVillageSize + difficulty * 3);
  const aggressivenessLevel = Math.max(
    0,
    Math.min(5, realmConfig.aggressivenessByVillageIndex[villageIndex] ?? 5)
  );
  const bounds = findVillageBounds(tileMap, playerCenter, size, villageIndex, existingBounds);
  if (!bounds) return null;

  const factionId = ENEMY_FACTIONS[villageIndex] ?? (`enemy_${villageIndex + 1}` as EnemyFactionId);
  const random = mulberry32(tileMap.getSeed() ^ 0xc0ffee ^ (villageIndex * 0x9e3779b9));
  const headquarters: EnemyVillageBuildingPlan = {
    type: 'base_camp',
    x: bounds.x + Math.floor(size / 2) - 2,
    y: bounds.y + Math.floor(size / 2) - 2,
  };
  const waterBase = { x: bounds.x + 3, y: bounds.y + bounds.height - 5 };
  const waterCells = [
    { x: waterBase.x, y: waterBase.y },
    { x: waterBase.x + 1, y: waterBase.y },
    { x: waterBase.x, y: waterBase.y + 1 },
    { x: waterBase.x + 1, y: waterBase.y + 1 },
    { x: waterBase.x + 2, y: waterBase.y + 1 },
  ];

  const occupied = new Set<string>();
  for (const plan of [headquarters]) {
    const def = dataManager.getBuilding(plan.type)!;
    for (const cell of rectCells(plan.x, plan.y, def.size.width, def.size.height))
      occupied.add(cell);
  }
  for (const cell of waterCells) occupied.add(key(cell.x, cell.y));

  const buildings: EnemyVillageBuildingPlan[] = [];
  const slots = createSlotGrid(bounds, random).filter(
    slot => Math.abs(slot.x - headquarters.x) + Math.abs(slot.y - headquarters.y) > 7
  );
  const militaryCount = Math.min(9, 1 + Math.floor(difficulty * 0.85));
  const civilianCount = Math.min(slots.length - militaryCount, 4 + difficulty * 2);
  const garrisonRank = (difficulty >= 7 ? 3 : difficulty >= 3 ? 2 : 1) as 1 | 2 | 3;
  const garrisonFillRatio = Math.min(1, 0.45 + difficulty * 0.065);

  let slotIndex = 0;
  const militaryTypes = chooseMilitaryTypes(difficulty, militaryCount);
  for (const type of militaryTypes) {
    while (slotIndex < slots.length) {
      if (
        tryPlaceBuilding(buildings, occupied, type, slots[slotIndex++]!, {
          seedGarrison: true,
          garrisonFillRatio,
          garrisonRank,
        })
      )
        break;
    }
  }

  const shuffledCivilian = [...CIVILIAN_TYPES].sort(() => random() - 0.5);
  for (let i = 0; i < civilianCount && slotIndex < slots.length; i++) {
    const type = shuffledCivilian[i % shuffledCivilian.length]!;
    while (slotIndex < slots.length) {
      if (tryPlaceBuilding(buildings, occupied, type, slots[slotIndex++]!)) break;
    }
  }

  const roads = new Map<string, { x: number; y: number }>();
  const hqRoad = getEntranceRoadCell(headquarters, occupied);
  roads.set(key(hqRoad.x, hqRoad.y), hqRoad);
  for (const building of buildings) {
    const road = getEntranceRoadCell(building, occupied);
    addRoadPath(roads, occupied, hqRoad, road, bounds);
  }

  const military = buildings.filter(b => b.seedGarrison);
  const nearestMilitary =
    military.length > 0
      ? military.reduce((best, cur) => {
          const curCenter = centerOf(cur);
          const bestCenter = centerOf(best);
          const curD =
            Math.abs(curCenter.x - playerCenter.x) + Math.abs(curCenter.y - playerCenter.y);
          const bestD =
            Math.abs(bestCenter.x - playerCenter.x) + Math.abs(bestCenter.y - playerCenter.y);
          return curD < bestD ? cur : best;
        }, military[0]!)
      : headquarters;
  const revealCenter = centerOf(nearestMilitary);
  const revealCells: { x: number; y: number }[] = [];
  if (villageIndex === 0) {
    for (let y = revealCenter.y - 7; y <= revealCenter.y + 7; y++) {
      for (let x = revealCenter.x - 7; x <= revealCenter.x + 7; x++) {
        if (
          tileMap.isInBounds(x, y) &&
          Math.max(Math.abs(x - revealCenter.x), Math.abs(y - revealCenter.y)) <= 7
        ) {
          revealCells.push({ x, y });
        }
      }
    }
  }

  return {
    id: `${factionId}_village`,
    factionId,
    difficulty,
    aggressivenessLevel,
    bounds,
    headquarters,
    buildings,
    roads: [...roads.values()],
    waterCells,
    revealCells,
  };
}

export function planEnemyVillages(
  tileMap: TileMap,
  playerCenter: { x: number; y: number }
): EnemyVillagePlan[] {
  const plans: EnemyVillagePlan[] = [];
  const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  const villageCount = dataManager.getGameConfig().enemyRealms.villageCount;
  for (let i = 0; i < villageCount; i++) {
    const plan = planEnemyVillage(tileMap, playerCenter, i, bounds);
    if (!plan) {
      console.warn(`Enemy village generation skipped for slot ${i + 1}: no valid site.`);
      continue;
    }
    plans.push(plan);
    bounds.push(plan.bounds);
  }

  return plans.sort((a, b) => {
    const acx = a.bounds.x + a.bounds.width / 2;
    const acy = a.bounds.y + a.bounds.height / 2;
    const bcx = b.bounds.x + b.bounds.width / 2;
    const bcy = b.bounds.y + b.bounds.height / 2;
    const ad = Math.max(Math.abs(acx - playerCenter.x), Math.abs(acy - playerCenter.y));
    const bd = Math.max(Math.abs(bcx - playerCenter.x), Math.abs(bcy - playerCenter.y));
    return ad - bd;
  });
}

export function planInitialEnemyVillage(
  tileMap: TileMap,
  playerCenter: { x: number; y: number }
): EnemyVillagePlan | null {
  return planEnemyVillages(tileMap, playerCenter)[0] ?? null;
}
