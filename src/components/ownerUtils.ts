import type { Entity } from '@/core/Entity';
import { Owner, type FactionId } from '@/components/Owner';

export type { FactionId } from '@/components/Owner';

export const PLAYER_FACTION: FactionId = 'player';
export const FIRST_ENEMY_FACTION: FactionId = 'enemy_1';

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
