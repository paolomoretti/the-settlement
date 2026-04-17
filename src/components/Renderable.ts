/**
 * Renderable component - defines how an entity should be rendered
 */

import { Component } from '@/core/Component';

export type RenderType = 'circle' | 'rectangle' | 'triangle' | 'sprite';

export class Renderable extends Component {
  constructor(
    public type: RenderType,
    public color: string,
    public size: { width: number; height: number },
    public offsetY: number = 0, // For vertical offset (e.g., jumping animation)
    public spritePath?: string, // Future: path to sprite
    public layer: number = 0 // Rendering layer (higher = on top)
  ) {
    super();
  }
}
