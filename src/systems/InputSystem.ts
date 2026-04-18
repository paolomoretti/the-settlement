/**
 * Input System - handles mouse and touch input
 *
 * Keyboard shortcuts are managed centrally in src/input/KeyboardShortcuts.ts
 */

import { eventBus } from '@/core/EventBus';
import { RenderSystem } from './RenderSystem';
import { BuildingType } from '@/types/GameData';

export type InputMode = 'view' | 'select' | `build_${BuildingType}`;

export class InputSystem {
  private mode: InputMode = 'view';
  private isDragging = false;
  private lastPos = { x: 0, y: 0 };
  private touchStartDistance = 0;
  public hoverGridPos: { x: number; y: number } | null = null;
  private dragStartGridPos: { x: number; y: number } | null = null;
  private spacebarPressed = false;
  private lastRoadBuildPos: { x: number; y: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderSystem: RenderSystem
  ) {
    this.setupEventListeners();

    eventBus.on('build:success', () => {
      if (this.mode !== 'view' && this.mode !== 'select' && this.mode !== 'build_road') {
        this.setMode('view');
      }
    });
  }

  setSpacebarPressed(pressed: boolean): void {
    this.spacebarPressed = pressed;
    this.canvas.style.cursor = pressed ? 'grab' : 'default';
  }

  private setupEventListeners(): void {
    // Mouse events
    this.canvas.addEventListener('mousedown', (e) => this.handlePointerDown(e.clientX, e.clientY));
    this.canvas.addEventListener('mousemove', (e) => this.handlePointerMove(e.clientX, e.clientY));
    this.canvas.addEventListener('mouseup', (e) => this.handlePointerUp(e.clientX, e.clientY));
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e));

    // Touch events
    this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', (e) => {
      if (e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        this.handlePointerUp(touch.clientX, touch.clientY);
      }
    }, { passive: false });

    // Prevent context menu
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handlePointerDown(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.lastPos = { x: clientX, y: clientY };

    // If spacebar is held, we're always in pan mode
    if (this.spacebarPressed) {
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    const worldPos = this.renderSystem.screenToWorld(clientX, clientY);
    this.dragStartGridPos = {
      x: Math.floor(worldPos.x),
      y: Math.floor(worldPos.y)
    };

    // Check if clicking on a selected entity to start dragging it
    if (this.mode === 'view') {
      eventBus.emit('check:drag_selected', this.dragStartGridPos);
    }

    // Place first road tile on mouse-down
    if (this.mode === 'build_road') {
      eventBus.emit('build:road', { x: this.dragStartGridPos.x, y: this.dragStartGridPos.y });
      this.lastRoadBuildPos = { ...this.dragStartGridPos };
    }
  }

  private handlePointerMove(clientX: number, clientY: number): void {
    // Update hover position for build preview
    const worldPos = this.renderSystem.screenToWorld(clientX, clientY);
    this.hoverGridPos = {
      x: Math.floor(worldPos.x),
      y: Math.floor(worldPos.y)
    };

    if (this.isDragging) {
      // Spacebar + drag = always pan camera (regardless of mode)
      if (this.spacebarPressed) {
        const dx = clientX - this.lastPos.x;
        const dy = clientY - this.lastPos.y;
        this.renderSystem.moveCamera(dx, dy);
        this.lastPos = { x: clientX, y: clientY };
      } else if (this.mode === 'select') {
        // Drag selected entity in real-time
        eventBus.emit('drag:move', { x: this.hoverGridPos.x, y: this.hoverGridPos.y });
      } else if (this.mode === 'build_road') {
        const gx = this.hoverGridPos.x;
        const gy = this.hoverGridPos.y;
        if (!this.lastRoadBuildPos || gx !== this.lastRoadBuildPos.x || gy !== this.lastRoadBuildPos.y) {
          eventBus.emit('build:road', { x: gx, y: gy });
          this.lastRoadBuildPos = { x: gx, y: gy };
        }
      } else if (this.mode === 'view') {
        // Check if we should be dragging an entity instead of panning
        const hasMoved = Math.abs(clientX - this.lastPos.x) > 5 || Math.abs(clientY - this.lastPos.y) > 5;
        if (!hasMoved) return; // Small movements don't count

        // If not dragging entity, pan camera
        const dx = clientX - this.lastPos.x;
        const dy = clientY - this.lastPos.y;
        this.renderSystem.moveCamera(dx, dy);
        this.lastPos = { x: clientX, y: clientY };
      }
    }
  }

  private handlePointerUp(clientX: number, clientY: number): void {
    // If spacebar was held, this was just panning - don't do anything else
    if (this.spacebarPressed) {
      this.canvas.style.cursor = 'grab';
      this.isDragging = false;
      this.dragStartGridPos = null;
      return;
    }

    // Use the actual mouse position at release time, not lastPos (which gets modified during panning)
    const worldPos = this.renderSystem.screenToWorld(clientX, clientY);
    const gridX = Math.floor(worldPos.x);
    const gridY = Math.floor(worldPos.y);

    if (this.isDragging) {
      if (this.mode === 'select') {
        // Drop dragged entity
        eventBus.emit('drag:end', { x: gridX, y: gridY });
        this.setMode('view'); // Return to view mode after drop
      } else if (this.mode === 'view') {
        // Check if this was a click (not a drag for panning)
        const isSamePos = this.dragStartGridPos &&
                         this.dragStartGridPos.x === gridX &&
                         this.dragStartGridPos.y === gridY;

        if (isSamePos) {
          // It's a click - handle selection
          eventBus.emit('select:entity', { x: gridX, y: gridY });
        }
      } else if (this.mode.startsWith('build_') && this.mode !== 'build_road') {
        // Handle building placement (road is handled on down/drag)
        const buildingType = this.mode.replace('build_', '');
        eventBus.emit(`build:${buildingType}`, { x: gridX, y: gridY });
      }
    }

    this.isDragging = false;
    this.dragStartGridPos = null;
    this.lastRoadBuildPos = null;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
    this.renderSystem.adjustZoom(zoomDelta, e.clientX, e.clientY);
  }

  private handleTouchStart(e: TouchEvent): void {
    e.preventDefault();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      this.handlePointerDown(touch.clientX, touch.clientY);
    } else if (e.touches.length === 2) {
      // Pinch to zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this.touchStartDistance = Math.sqrt(dx * dx + dy * dy);
    }
  }

  private handleTouchMove(e: TouchEvent): void {
    e.preventDefault();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      this.handlePointerMove(touch.clientX, touch.clientY);
    } else if (e.touches.length === 2) {
      // Pinch zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (this.touchStartDistance > 0) {
        const zoomDelta = distance / this.touchStartDistance;
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        this.renderSystem.adjustZoom(zoomDelta, centerX, centerY);
      }

      this.touchStartDistance = distance;
    }
  }

  setMode(mode: InputMode): void {
    this.mode = mode;
    eventBus.emit('input:mode_changed', mode);
  }

  getMode(): InputMode {
    return this.mode;
  }
}
