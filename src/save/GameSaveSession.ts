/**
 * Save slots, resume pointer, and autosave — isolated from bootstrap UI (main.ts).
 */

import type { Game } from '@/core/Game';
import { eventBus } from '@/core/EventBus';

export const SAVE_SLOT_PREFIX = 'settler_save_';
export const LAST_SAVE_KEY = 'settler_last_save_slot';

const SLOT_COUNT = 10;

/** Debounced autosave after this much quiet time following a world mutation */
const AUTO_SAVE_DEBOUNCE_MS = 5 * 1000;

/** Minimum interval between timed autosaves */
const AUTO_SAVE_INTERVAL_MS = 2 * 60 * 1000;

const AUTO_SAVE_EVENTS = [
  'build:success',
  'build:road',
  'road:drag_end',
  'erase:done',
  'delete:selected',
  'drag:end',
  'survey:session_updated',
] as const;

export interface GameSaveSessionDeps {
  getGame: () => Game | null;
  isAutosaveEnabled: () => boolean;
  toast: (msg: string) => void;
}

export interface SlotPayload {
  name: string;
  timestamp: number;
  data: unknown;
}

export function anySaveSlotsExist(): boolean {
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (localStorage.getItem(`${SAVE_SLOT_PREFIX}${i}`)) return true;
  }
  return false;
}

export class GameSaveSession {
  private currentSlot: number | null = null;
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  private autoSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSaveEventCleanup: (() => void) | null = null;
  private unloadHooksRegistered = false;

  constructor(private deps: GameSaveSessionDeps) {}

  getCurrentSlot(): number | null {
    return this.currentSlot;
  }

  /** Binds resume slot (e.g. after loading from welcome or in-game load). */
  bindResumeSlot(index: number): void {
    this.currentSlot = index;
    localStorage.setItem(LAST_SAVE_KEY, index.toString());
  }

  /** New game / exit: no active slot, do not auto-resume stale slot. */
  clearResumeAndSlot(): void {
    localStorage.removeItem(LAST_SAVE_KEY);
    this.currentSlot = null;
  }

  parseResumeSlotIndex(): number | null {
    const raw = localStorage.getItem(LAST_SAVE_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }

  clearStaleResumeKey(): void {
    localStorage.removeItem(LAST_SAVE_KEY);
  }

  getFullSlotData(index: number): SlotPayload | null {
    const raw = localStorage.getItem(`${SAVE_SLOT_PREFIX}${index}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SlotPayload;
    } catch {
      return null;
    }
  }

  getSlotMeta(index: number): { name: string; timestamp: number } | null {
    const data = this.getFullSlotData(index);
    if (!data) return null;
    return { name: data.name, timestamp: data.timestamp };
  }

  saveToSlot(index: number, name: string): boolean {
    const game = this.deps.getGame();
    if (!game) return false;
    try {
      const gameData = game.getSaveData();
      const slotData: SlotPayload = { name, timestamp: Date.now(), data: gameData };
      const key = `${SAVE_SLOT_PREFIX}${index}`;
      localStorage.setItem(key, JSON.stringify(slotData));
      localStorage.setItem(LAST_SAVE_KEY, index.toString());
      this.currentSlot = index;
      return true;
    } catch (e) {
      console.error('saveToSlot failed:', e);
      this.deps.toast('Save failed (storage may be full)');
      return false;
    }
  }

  private findFirstEmptySaveSlot(): number | null {
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (!localStorage.getItem(`${SAVE_SLOT_PREFIX}${i}`)) return i;
    }
    return null;
  }

  /**
   * When autosave is on but no slot is bound yet, claim the first empty slot (0–9)
   * named "autosave". If every slot is full, slot 0 is overwritten.
   */
  ensureAutoSaveSlot(): boolean {
    const game = this.deps.getGame();
    if (!game) return false;
    if (this.currentSlot !== null && this.getSlotMeta(this.currentSlot)) {
      return true;
    }
    if (this.currentSlot !== null && !this.getSlotMeta(this.currentSlot)) {
      return this.saveToSlot(this.currentSlot, 'autosave');
    }
    const empty = this.findFirstEmptySaveSlot();
    const index = empty !== null ? empty : 0;
    return this.saveToSlot(index, 'autosave');
  }

  openSaveDialog(onComplete?: () => void, dialogTitle: string = 'Save Game'): void {
    const dialog = document.getElementById('save-load-dialog')!;
    const title = document.getElementById('save-load-title')!;
    const slotsContainer = document.getElementById('save-load-slots')!;

    title.textContent = dialogTitle;
    this.renderSlots(slotsContainer, 'save', (slotIndex, name) => {
      if (!this.saveToSlot(slotIndex, name!)) return;
      dialog.style.display = 'none';
      this.deps.toast('Game saved!');
      onComplete?.();
    });

    dialog.style.display = 'flex';
  }

  openLoadDialog(onLoad: (slotIndex: number) => void): void {
    const dialog = document.getElementById('save-load-dialog')!;
    const title = document.getElementById('save-load-title')!;
    const slotsContainer = document.getElementById('save-load-slots')!;

    title.textContent = 'Load Game';
    this.renderSlots(slotsContainer, 'load', (slotIndex) => {
      dialog.style.display = 'none';
      onLoad(slotIndex);
    });

    dialog.style.display = 'flex';
  }

  private renderSlots(
    container: HTMLElement,
    mode: 'save' | 'load',
    onAction: (slotIndex: number, name?: string) => void,
    editingIndex: number | null = null
  ): void {
    container.innerHTML = '';

    for (let i = 0; i < SLOT_COUNT; i++) {
      const meta = this.getSlotMeta(i);
      const slot = document.createElement('div');

      if (mode === 'save' && editingIndex === i) {
        slot.className = 'save-slot editing';
        slot.innerHTML = `
        <span class="slot-number">${i + 1}.</span>
        <input type="text" class="slot-name-input" value="${GameSaveSession.escapeAttr(meta?.name || '')}" placeholder="Enter save name..." />
      `;
      } else {
        slot.className = 'save-slot' + (meta ? ' filled' : '');
        if (meta) {
          const date = new Date(meta.timestamp);
          const dateStr =
            date.toLocaleDateString() +
            ' ' +
            date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          slot.innerHTML = `
          <span class="slot-number">${i + 1}.</span>
          <span class="slot-name">${GameSaveSession.escapeHtml(meta.name)}</span>
          <span class="slot-date">${dateStr}</span>
          ${mode === 'save' ? '<span class="slot-edit-btn" title="Rename">&#9998;</span>' : ''}
        `;
        } else {
          slot.innerHTML = `
          <span class="slot-number">${i + 1}.</span>
          <span class="slot-name empty-label">Empty</span>
          <span class="slot-date"></span>
        `;
        }
      }

      container.appendChild(slot);

      if (mode === 'save' && editingIndex === i) {
        const input = slot.querySelector('.slot-name-input') as HTMLInputElement;
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.stopPropagation();
            onAction(i, input.value.trim() || `Save ${i + 1}`);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            this.renderSlots(container, mode, onAction);
          }
        });
      } else if (mode === 'save' && meta) {
        slot.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).classList.contains('slot-edit-btn')) {
            this.renderSlots(container, mode, onAction, i);
          } else {
            onAction(i, meta.name);
          }
        });
      } else if (mode === 'save') {
        slot.addEventListener('click', () => {
          this.renderSlots(container, mode, onAction, i);
        });
      } else if (mode === 'load' && meta) {
        slot.addEventListener('click', () => onAction(i));
      } else if (mode === 'load') {
        slot.classList.add('disabled');
      }
    }
  }

  private static escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  private static escapeAttr(str: string): string {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  registerUnloadHooksOnce(): void {
    if (this.unloadHooksRegistered) return;
    this.unloadHooksRegistered = true;
    const flush = () => this.flushPendingAutoSaveSync();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
  }

  /** Call after Game.start() when entering the game with autosave enabled in options. */
  startAutoSaveIfEnabled(): void {
    if (!this.deps.isAutosaveEnabled()) return;
    this.startAutoSave();
  }

  startAutoSave(): void {
    this.stopAutoSave();
    this.resetAutoSaveInterval();
    const handler = () => this.scheduleAutoSaveDebounce();
    for (const evt of AUTO_SAVE_EVENTS) eventBus.on(evt, handler);
    this.autoSaveEventCleanup = () => {
      for (const evt of AUTO_SAVE_EVENTS) eventBus.off(evt, handler);
    };
    const game = this.deps.getGame();
    if (game) {
      this.ensureAutoSaveSlot();
    }
  }

  stopAutoSave(): void {
    if (this.autoSaveInterval !== null) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    if (this.autoSaveDebounceTimer !== null) {
      clearTimeout(this.autoSaveDebounceTimer);
      this.autoSaveDebounceTimer = null;
    }
    if (this.autoSaveEventCleanup) {
      this.autoSaveEventCleanup();
      this.autoSaveEventCleanup = null;
    }
  }

  private performAutoSave(): void {
    if (!this.deps.isAutosaveEnabled() || !this.deps.getGame()) return;
    const hadBoundSlot = this.currentSlot !== null && !!this.getSlotMeta(this.currentSlot);
    if (!this.ensureAutoSaveSlot()) return;
    if (hadBoundSlot) {
      const meta = this.getSlotMeta(this.currentSlot!);
      if (!meta || !this.saveToSlot(this.currentSlot!, meta.name)) return;
    }
    this.deps.toast('Auto saved');
  }

  private resetAutoSaveInterval(): void {
    if (this.autoSaveInterval !== null) clearInterval(this.autoSaveInterval);
    this.autoSaveInterval = setInterval(() => this.performAutoSave(), AUTO_SAVE_INTERVAL_MS);
  }

  private scheduleAutoSaveDebounce(): void {
    if (!this.deps.isAutosaveEnabled()) return;
    if (this.autoSaveDebounceTimer !== null) clearTimeout(this.autoSaveDebounceTimer);
    this.autoSaveDebounceTimer = setTimeout(() => {
      this.autoSaveDebounceTimer = null;
      this.performAutoSave();
      this.resetAutoSaveInterval();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  private flushPendingAutoSaveSync(): void {
    if (this.autoSaveDebounceTimer !== null) {
      clearTimeout(this.autoSaveDebounceTimer);
      this.autoSaveDebounceTimer = null;
    }
    if (!this.deps.isAutosaveEnabled() || !this.deps.getGame()) return;
    if (!this.ensureAutoSaveSlot()) return;
    const meta = this.getSlotMeta(this.currentSlot!);
    this.saveToSlot(this.currentSlot!, meta?.name ?? 'autosave');
  }
}
