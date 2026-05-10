import { TileMap } from '@/map/TileMap';

/** RLE terrain string: all grass, row-major. */
export function grassTerrainRle(width: number, height: number): string {
  return `${width * height}g`;
}

export function createGrassTileMap(
  width: number,
  height: number,
  opts?: { roads?: { x: number; y: number }[]; seed?: number }
): TileMap {
  const map = TileMap.deserialize({
    width,
    height,
    seed: opts?.seed ?? 42,
    terrain: grassTerrainRle(width, height),
    roads: (opts?.roads ?? []).map(c => `${c.x},${c.y}`).join(';'),
  });
  return map;
}

/** Same rule as `RoadSegmentManager.rebuildRoadTileSet` — segment graph uses open road cells only. */
export function collectOpenRoadKeys(tileMap: TileMap): Set<string> {
  const keys = new Set<string>();
  for (let y = 0; y < tileMap.height; y++) {
    for (let x = 0; x < tileMap.width; x++) {
      const t = tileMap.getTile(x, y);
      if (t && t.hasRoad && !t.isOccupied()) {
        keys.add(`${x},${y}`);
      }
    }
  }
  return keys;
}

/**
 * Mirrors `Game.getBaseCampConnectedRoads` — keep in sync when that routine changes
 * (HQ entrance may be occupied+hasRoad; BFS seeds there; expansion allows HQ-occupied road
 * tiles only for `hqEntityId`).
 */
export function floodFillHqRoadNetwork(
  tileMap: TileMap,
  hqEntityId: number,
  entranceX: number,
  entranceY: number
): Set<string> {
  const connected = new Set<string>();

  const isHqRoadNetworkTile = (x: number, y: number): boolean => {
    const t = tileMap.getTile(x, y);
    if (!t || !t.hasRoad) return false;
    if (!t.isOccupied()) return true;
    return t.occupiedBy === hqEntityId;
  };

  const queue: { x: number; y: number }[] = [];
  const seed = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (connected.has(key)) return;
    if (!isHqRoadNetworkTile(x, y)) return;
    connected.add(key);
    queue.push({ x, y });
  };

  seed(entranceX, entranceY);

  const cardinalDirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    for (const [dx, dy] of cardinalDirs) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (connected.has(key)) continue;
      const neighbor = tileMap.getTile(nx, ny);
      if (
        neighbor &&
        neighbor.hasRoad &&
        (!neighbor.isOccupied() || neighbor.occupiedBy === hqEntityId)
      ) {
        connected.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  return connected;
}

/**
 * Open-road keys the segment manager can actually cover (excludes HQ entrance tile itself
 * when it is occupied road — those cells are not in `roadTiles`).
 */
export function hqConnectedOpenRoadKeys(
  tileMap: TileMap,
  hqConnected: Set<string>
): Set<string> {
  const out = new Set<string>();
  for (const key of hqConnected) {
    const [x, y] = key.split(',').map(Number);
    const t = tileMap.getTile(x, y);
    if (t && t.hasRoad && !t.isOccupied()) {
      out.add(key);
    }
  }
  return out;
}
