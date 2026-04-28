/**
 * Input System - handles mouse and touch input
 *
 * Keyboard shortcuts are managed centrally in src/input/KeyboardShortcuts.ts
 *
 * Right mouse button: always camera pan on the canvas (no place/erase/select).
 * See .claude/GAME_INPUTS.md for the full control reference.
 */

import { eventBus } from '@/core/EventBus';
import { RenderSystem } from './RenderSystem';
import { BuildingType } from '@/types/GameData';

export type InputMode = 'view' | 'select' | 'erase' | `build_${BuildingType}`;

export class InputSystem {
  private mode: InputMode = 'view';
  private isDragging = false;
  private lastPos = { x: 0, y: 0 };
  private touchStartDistance = 0;
  public hoverGridPos: { x: number; y: number } | null = null;
  /** Last pointer position in viewport pixels (for canvas hover UI). */
  public hoverClientPos: { x: number; y: number } | null = null;
  private dragStartGridPos: { x: number; y: number } | null = null;
  private spacebarPressed = false;
  private lastRoadBuildPos: { x: number; y: number } | null = null;
  /** Last road cell intentionally placed; Shift-click uses it as point A for path building. */
  private roadPathAnchorGridPos: { x: number; y: number } | null = null;
  private lastErasePos: { x: number; y: number } | null = null;
  /** Last known Shift key (for straight road row while dragging). */
  private shiftKeyHeld = false;
  /** View mode: true once this pointer gesture has panned the camera (suppress click on release). */
  private viewDragDidPan = false;
  /** Right mouse (button 2): entire gesture is camera pan only — no build, erase, select, or drag. */
  private isRightButtonPan = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderSystem: RenderSystem
  ) {
    this.setupEventListeners();

    eventBus.on('build:success', () => {
      if (this.mode !== 'view' && this.mode !== 'select' && this.mode !== 'build_road' && this.mode !== 'erase') {
        this.setMode('view');
      }
    });
  }

  setSpacebarPressed(pressed: boolean): void {
    this.spacebarPressed = pressed;
    if (pressed) {
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.canvas.style.cursor = this.mode === 'erase' ? 'crosshair' : 'default';
    }
  }

  private setupEventListeners(): void {
    // Mouse events
    this.canvas.addEventListener('mousedown', (e) =>
      this.handlePointerDown(e.clientX, e.clientY, e.shiftKey, e.button, e.buttons)
    );
    this.canvas.addEventListener('mousemove', (e) =>
      this.handlePointerMove(
        e.clientX,
        e.clientY,
        e.shiftKey,
        'buttons' in e ? (e as MouseEvent).buttons : undefined
      )
    );
    this.canvas.addEventListener('mouseup', (e) =>
      this.handlePointerUp(e.clientX, e.clientY, e.shiftKey, e.button)
    );
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

  private handlePointerDown(
    clientX: number,
    clientY: number,
    shiftKey = false,
    button = 0,
    mouseButtons?: number
  ): void {
    // Right pan ended off-canvas without our mouseup — clear stale gesture before a new press
    const rightStillDown = mouseButtons !== undefined && (mouseButtons & 2) !== 0;
    if (button !== 2 && this.isRightButtonPan && !rightStillDown) {
      this.isRightButtonPan = false;
      this.isDragging = false;
      this.dragStartGridPos = null;
      this.lastRoadBuildPos = null;
      this.lastErasePos = null;
      eventBus.emit('road:drag_end');
    }

    this.hoverClientPos = { x: clientX, y: clientY };
    this.shiftKeyHeld = shiftKey;
    this.isDragging = true;
    this.lastPos = { x: clientX, y: clientY };
    this.viewDragDidPan = false;

    // If spacebar is held, we're always in pan mode
    if (this.spacebarPressed) {
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Right mouse: pan only (never place roads/buildings, erase, or select)
    if (button === 2) {
      this.isRightButtonPan = true;
      this.canvas.style.cursor = 'grabbing';
      const w = this.renderSystem.clientToGrid(clientX, clientY);
      this.hoverGridPos = { x: w.x, y: w.y };
      return;
    }

    const worldPos = this.renderSystem.clientToGrid(clientX, clientY);
    this.dragStartGridPos = {
      x: worldPos.x,
      y: worldPos.y
    };

    // Check if clicking on a selected entity to start dragging it
    if (this.mode === 'view') {
      eventBus.emit('check:drag_selected', this.dragStartGridPos);
    }

    // Place first road tile on mouse-down, or complete an anchored Shift road path.
    if (this.mode === 'build_road') {
      if (shiftKey && this.roadPathAnchorGridPos) {
        eventBus.emit('build:road_path', {
          from: { ...this.roadPathAnchorGridPos },
          to: { x: this.dragStartGridPos.x, y: this.dragStartGridPos.y }
        });
      } else {
        eventBus.emit('build:road', { x: this.dragStartGridPos.x, y: this.dragStartGridPos.y });
      }
      this.roadPathAnchorGridPos = { ...this.dragStartGridPos };
      this.lastRoadBuildPos = { ...this.dragStartGridPos };
    }

    if (this.mode === 'erase') {
      eventBus.emit('erase:tile', { x: this.dragStartGridPos.x, y: this.dragStartGridPos.y });
      this.lastErasePos = { ...this.dragStartGridPos };
    }
  }

  private handlePointerMove(clientX: number, clientY: number, shiftKey = false, mouseButtons?: number): void {
    this.hoverClientPos = { x: clientX, y: clientY };
    this.shiftKeyHeld = shiftKey;

    if (
      this.isRightButtonPan &&
      mouseButtons !== undefined &&
      (mouseButtons & 2) === 0
    ) {
      this.handlePointerUp(clientX, clientY, shiftKey, 2);
      return;
    }

    const raw = this.renderSystem.clientToGrid(clientX, clientY);
    let gx = raw.x;
    let gy = raw.y;

    if (
      this.isDragging &&
      this.mode === 'build_road' &&
      this.dragStartGridPos &&
      shiftKey &&
      !this.roadPathAnchorGridPos
    ) {
      const snapped = this.renderSystem.snapRoadHoverToAxisAlignedRow(
        this.dragStartGridPos.x,
        this.dragStartGridPos.y,
        gx,
        gy,
        clientX,
        clientY
      );
      gx = snapped.x;
      gy = snapped.y;
    }

    this.hoverGridPos = { x: gx, y: gy };

    if (this.isDragging) {
      // Spacebar or right mouse + drag = pan camera only (regardless of mode)
      if (this.spacebarPressed || this.isRightButtonPan) {
        const dx = clientX - this.lastPos.x;
        const dy = clientY - this.lastPos.y;
        this.renderSystem.moveCamera(dx, dy);
        this.lastPos = { x: clientX, y: clientY };
      } else if (this.mode === 'select') {
        // Drag selected entity in real-time
        eventBus.emit('drag:move', { x: this.hoverGridPos.x, y: this.hoverGridPos.y });
      } else if (this.mode === 'build_road') {
        if (shiftKey && this.roadPathAnchorGridPos) return;
        const gx = this.hoverGridPos.x;
        const gy = this.hoverGridPos.y;
        if (!this.lastRoadBuildPos || gx !== this.lastRoadBuildPos.x || gy !== this.lastRoadBuildPos.y) {
          eventBus.emit('build:road', { x: gx, y: gy });
          this.lastRoadBuildPos = { x: gx, y: gy };
        }
      } else if (this.mode === 'erase') {
        const gx = this.hoverGridPos.x;
        const gy = this.hoverGridPos.y;
        if (!this.lastErasePos || gx !== this.lastErasePos.x || gy !== this.lastErasePos.y) {
          eventBus.emit('erase:tile', { x: gx, y: gy });
          this.lastErasePos = { x: gx, y: gy };
        }
      } else if (this.mode === 'view') {
        // Check if we should be dragging an entity instead of panning
        const hasMoved = Math.abs(clientX - this.lastPos.x) > 5 || Math.abs(clientY - this.lastPos.y) > 5;
        if (!hasMoved) return; // Small movements don't count

        // If not dragging entity, pan camera
        const dx = clientX - this.lastPos.x;
        const dy = clientY - this.lastPos.y;
        this.renderSystem.moveCamera(dx, dy);
        this.viewDragDidPan = true;
        this.lastPos = { x: clientX, y: clientY };
      }
    }
  }

  private handlePointerUp(clientX: number, clientY: number, shiftKey = false, button = 0): void {
    this.shiftKeyHeld = shiftKey;

    if (this.isRightButtonPan && button === 2) {
      this.isRightButtonPan = false;
      this.isDragging = false;
      this.dragStartGridPos = null;
      this.viewDragDidPan = false;
      this.lastRoadBuildPos = null;
      this.lastErasePos = null;
      if (this.spacebarPressed) {
        this.canvas.style.cursor = 'grabbing';
      } else {
        this.canvas.style.cursor = this.mode === 'erase' ? 'crosshair' : 'default';
      }
      eventBus.emit('road:drag_end');
      return;
    }

    // If spacebar was held, this was just panning - don't do anything else
    if (this.spacebarPressed) {
      this.canvas.style.cursor = 'grab';
      this.isDragging = false;
      this.dragStartGridPos = null;
      this.viewDragDidPan = false;
      return;
    }

    // Use the actual mouse position at release time, not lastPos (which gets modified during panning)
    const worldPos = this.renderSystem.clientToGrid(clientX, clientY);
    const gridX = worldPos.x;
    const gridY = worldPos.y;

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

        if (isSamePos && !this.viewDragDidPan) {
          // It's a click - handle selection
          eventBus.emit('select:entity', { x: gridX, y: gridY, clientX, clientY });
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
    this.lastErasePos = null;
    this.viewDragDidPan = false;
    eventBus.emit('road:drag_end');
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
      this.hoverClientPos = { x: touch.clientX, y: touch.clientY };
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
    if (mode !== 'build_road') {
      this.roadPathAnchorGridPos = null;
    }
    if (!this.spacebarPressed) {
      this.canvas.style.cursor = mode === 'erase' ? 'crosshair' : 'default';
    }
    eventBus.emit('input:mode_changed', mode);
  }

  getMode(): InputMode {
    return this.mode;
  }

  /** True between pointer down and up (road / erase / drag). */
  isPointerDragging(): boolean {
    return this.isDragging;
  }

  getShiftKeyHeld(): boolean {
    return this.shiftKeyHeld;
  }

  /** First cell of the current pointer gesture (road row anchor while dragging). */
  getRoadDragAnchorGrid(): { x: number; y: number } | null {
    if (this.mode !== 'build_road' || !this.isDragging || !this.dragStartGridPos) return null;
    return { ...this.dragStartGridPos };
  }

  /** Point A for Shift-click road planning. Persists across road clicks while in road mode. */
  getRoadPathAnchorGrid(): { x: number; y: number } | null {
    if (this.mode !== 'build_road' || !this.roadPathAnchorGridPos) return null;
    return { ...this.roadPathAnchorGridPos };
  }

  getHoverClientPos(): { x: number; y: number } | null {
    return this.hoverClientPos;
  }

  isSpacebarPanning(): boolean {
    return this.spacebarPressed;
  }
}
