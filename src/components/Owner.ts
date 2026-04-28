import { Component } from '@/core/Component';

export type EnemyFactionId = `enemy_${number}`;
export type FactionId = 'player' | EnemyFactionId;

export class Owner extends Component {
  constructor(public factionId: FactionId = 'player') {
    super();
  }
}
