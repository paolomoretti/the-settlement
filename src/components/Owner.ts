import { Component } from '@/core/Component';

export type FactionId = 'player' | 'enemy_1';

export class Owner extends Component {
  constructor(public factionId: FactionId = 'player') {
    super();
  }
}
