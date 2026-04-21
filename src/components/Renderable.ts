/**
 * Renderable component - defines how an entity should be rendered
 */

import { Component } from '@/core/Component';

export type RenderType = 'circle' | 'rectangle' | 'triangle' | 'sprite' | 'worker';

export class Renderable extends Component {
  constructor(
    public type: RenderType,
    public color: string,
    public size: { width: number; height: number },
    public offsetX: number = 0,
    public offsetY: number = 0, // Vertical nudge / jumping animation
    public spritePath?: string, // Future: path to sprite
    public layer: number = 0 // Rendering layer (higher = on top)
  ) {
    super();
  }
}
