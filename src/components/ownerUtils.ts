import type { Entity } from '@/core/Entity';
import { Owner, type EnemyFactionId, type FactionId } from '@/components/Owner';

export type { EnemyFactionId, FactionId } from '@/components/Owner';

export const PLAYER_FACTION: FactionId = 'player';
export const ENEMY_FACTIONS = [
  'enemy_1',
  'enemy_2',
  'enemy_3',
  'enemy_4',
  'enemy_5',
  'enemy_6',
  'enemy_7',
  'enemy_8',
  'enemy_9',
  'enemy_10',
] as const satisfies readonly EnemyFactionId[];
export const FIRST_ENEMY_FACTION: EnemyFactionId = ENEMY_FACTIONS[0];

export type FactionVisualStyle = {
  flag: string;
  flagStroke: string;
  flagHighlight: string;
  poleDark: string;
  poleLight: string;
  rope: string;
  ropeHighlight: string;
  minimap: string;
};

const ENEMY_FACTION_STYLES: Partial<Record<EnemyFactionId, FactionVisualStyle>> = {
  enemy_1: {
    flag: 'rgba(155, 24, 31, 0.96)',
    flagStroke: 'rgba(80, 12, 16, 0.9)',
    flagHighlight: 'rgba(255, 120, 110, 0.45)',
    poleDark: 'rgba(80, 18, 18, 0.98)',
    poleLight: 'rgba(155, 42, 42, 0.82)',
    rope: 'rgba(190, 34, 42, 0.94)',
    ropeHighlight: 'rgba(255, 135, 125, 0.58)',
    minimap: '#d32f2f',
  },
  enemy_2: {
    flag: 'rgba(25, 92, 172, 0.96)',
    flagStroke: 'rgba(8, 38, 88, 0.9)',
    flagHighlight: 'rgba(120, 185, 255, 0.45)',
    poleDark: 'rgba(10, 42, 82, 0.98)',
    poleLight: 'rgba(55, 122, 190, 0.82)',
    rope: 'rgba(42, 125, 220, 0.94)',
    ropeHighlight: 'rgba(135, 200, 255, 0.58)',
    minimap: '#1976d2',
  },
  enemy_3: {
    flag: 'rgba(60, 132, 46, 0.96)',
    flagStroke: 'rgba(20, 68, 24, 0.9)',
    flagHighlight: 'rgba(164, 226, 130, 0.45)',
    poleDark: 'rgba(24, 70, 22, 0.98)',
    poleLight: 'rgba(80, 150, 68, 0.82)',
    rope: 'rgba(76, 175, 80, 0.94)',
    ropeHighlight: 'rgba(180, 235, 150, 0.58)',
    minimap: '#388e3c',
  },
  enemy_4: {
    flag: 'rgba(126, 67, 178, 0.96)',
    flagStroke: 'rgba(54, 24, 92, 0.9)',
    flagHighlight: 'rgba(205, 150, 255, 0.45)',
    poleDark: 'rgba(60, 28, 90, 0.98)',
    poleLight: 'rgba(140, 80, 190, 0.82)',
    rope: 'rgba(156, 78, 210, 0.94)',
    ropeHighlight: 'rgba(222, 165, 255, 0.58)',
    minimap: '#7b1fa2',
  },
  enemy_5: {
    flag: 'rgba(220, 126, 24, 0.96)',
    flagStroke: 'rgba(118, 54, 8, 0.9)',
    flagHighlight: 'rgba(255, 202, 116, 0.45)',
    poleDark: 'rgba(96, 42, 14, 0.98)',
    poleLight: 'rgba(200, 112, 34, 0.82)',
    rope: 'rgba(245, 124, 0, 0.94)',
    ropeHighlight: 'rgba(255, 196, 105, 0.58)',
    minimap: '#f57c00',
  },
  enemy_6: {
    flag: 'rgba(0, 137, 150, 0.96)',
    flagStroke: 'rgba(0, 70, 78, 0.9)',
    flagHighlight: 'rgba(125, 230, 230, 0.45)',
    poleDark: 'rgba(0, 72, 78, 0.98)',
    poleLight: 'rgba(38, 165, 172, 0.82)',
    rope: 'rgba(0, 172, 193, 0.94)',
    ropeHighlight: 'rgba(128, 235, 240, 0.58)',
    minimap: '#0097a7',
  },
  enemy_7: {
    flag: 'rgba(188, 42, 132, 0.96)',
    flagStroke: 'rgba(90, 12, 58, 0.9)',
    flagHighlight: 'rgba(255, 145, 210, 0.45)',
    poleDark: 'rgba(92, 18, 64, 0.98)',
    poleLight: 'rgba(200, 64, 144, 0.82)',
    rope: 'rgba(216, 27, 96, 0.94)',
    ropeHighlight: 'rgba(255, 150, 210, 0.58)',
    minimap: '#c2185b',
  },
  enemy_8: {
    flag: 'rgba(110, 92, 42, 0.96)',
    flagStroke: 'rgba(62, 48, 18, 0.9)',
    flagHighlight: 'rgba(214, 194, 120, 0.45)',
    poleDark: 'rgba(68, 52, 24, 0.98)',
    poleLight: 'rgba(152, 130, 68, 0.82)',
    rope: 'rgba(158, 140, 58, 0.94)',
    ropeHighlight: 'rgba(230, 210, 130, 0.58)',
    minimap: '#8d6e63',
  },
  enemy_9: {
    flag: 'rgba(82, 118, 140, 0.96)',
    flagStroke: 'rgba(30, 58, 78, 0.9)',
    flagHighlight: 'rgba(160, 210, 235, 0.45)',
    poleDark: 'rgba(34, 62, 78, 0.98)',
    poleLight: 'rgba(94, 150, 172, 0.82)',
    rope: 'rgba(96, 150, 180, 0.94)',
    ropeHighlight: 'rgba(170, 220, 245, 0.58)',
    minimap: '#607d8b',
  },
  enemy_10: {
    flag: 'rgba(90, 46, 30, 0.96)',
    flagStroke: 'rgba(50, 20, 12, 0.9)',
    flagHighlight: 'rgba(196, 125, 92, 0.45)',
    poleDark: 'rgba(54, 24, 16, 0.98)',
    poleLight: 'rgba(138, 70, 46, 0.82)',
    rope: 'rgba(121, 67, 46, 0.94)',
    ropeHighlight: 'rgba(210, 135, 95, 0.58)',
    minimap: '#5d4037',
  },
};

export function isEnemyFactionId(value: unknown): value is EnemyFactionId {
  return typeof value === 'string' && /^enemy_\d+$/.test(value);
}

export function getEnemyFactionStyle(factionId: FactionId): FactionVisualStyle {
  if (isEnemyFactionId(factionId) && ENEMY_FACTION_STYLES[factionId]) {
    return ENEMY_FACTION_STYLES[factionId];
  }
  return ENEMY_FACTION_STYLES[FIRST_ENEMY_FACTION]!;
}

export function getEntityFaction(entity: Entity): FactionId {
  return entity.getComponent(Owner)?.factionId ?? PLAYER_FACTION;
}

export function isPlayerOwned(entity: Entity): boolean {
  return getEntityFaction(entity) === PLAYER_FACTION;
}

export function setEntityFaction(entity: Entity, factionId: FactionId): void {
  const owner = entity.getComponent(Owner);
  if (owner) {
    owner.factionId = factionId;
  } else {
    entity.addComponent(new Owner(factionId));
  }
}
