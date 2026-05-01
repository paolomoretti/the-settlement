/**
 * ConfirmDeleteDialog - modal confirmation dialog before demolishing a building.
 *
 * Shown when the player clicks "Delete Building" in the building popover OR when
 * the erase tool targets a building cell.
 */
export class ConfirmDeleteDialog {
  private overlay: HTMLElement;
  private messageEl: HTMLElement;
  private confirmBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private currentCallback: (() => void) | null = null;
  private escHandler: (e: KeyboardEvent) => void;

  constructor() {
    this.overlay = document.getElementById('confirm-delete-building-dialog')!;
    this.messageEl = document.getElementById('confirm-delete-building-message')!;
    this.confirmBtn = document.getElementById('btn-confirm-delete-building') as HTMLButtonElement;
    this.cancelBtn = document.getElementById('btn-cancel-delete-building') as HTMLButtonElement;

    this.confirmBtn.addEventListener('click', () => this.confirm());
    this.cancelBtn.addEventListener('click', () => this.cancel());

    // Click on the dark backdrop (outside the panel) cancels
    this.overlay.addEventListener('click', e => {
      if (e.target === this.overlay) this.cancel();
    });

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isVisible()) this.cancel();
    };
  }

  /** Show the dialog for the given building name and call `onConfirm` if the user confirms. */
  show(buildingName: string, onConfirm: () => void): void {
    this.currentCallback = onConfirm;
    this.messageEl.textContent = `Are you sure you want to delete the ${buildingName}? This cannot be undone.`;
    this.overlay.style.display = 'flex';
    document.addEventListener('keydown', this.escHandler);
  }

  isVisible(): boolean {
    return this.overlay.style.display === 'flex';
  }

  private confirm(): void {
    const cb = this.currentCallback;
    this.currentCallback = null;
    this.hide();
    cb?.();
  }

  private cancel(): void {
    this.currentCallback = null;
    this.hide();
  }

  private hide(): void {
    this.overlay.style.display = 'none';
    document.removeEventListener('keydown', this.escHandler);
  }
}
