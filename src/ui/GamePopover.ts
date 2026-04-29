import { computePosition, autoPlacement, shift, offset } from '@floating-ui/dom';

export type AnchorFn = () => { x: number; y: number };

export class GamePopover {
  private el: HTMLElement;
  private headerEl: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private anchorFn: AnchorFn | null = null;
  private rafId: number | null = null;
  private _onClose: (() => void) | null = null;
  private escHandler: (e: KeyboardEvent) => void;
  private outsidePointerHandler: ((e: PointerEvent) => void) | null = null;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'game-popover';
    this.el.style.display = 'none';

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'game-popover-header';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'game-popover-title';
    this.headerEl.appendChild(this.titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'game-popover-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.hide();
    });
    this.headerEl.appendChild(closeBtn);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'game-popover-body';

    const inner = document.createElement('div');
    inner.className = 'dialog-panel-body';
    inner.appendChild(this.headerEl);
    inner.appendChild(this.bodyEl);
    this.el.appendChild(inner);
    container.appendChild(this.el);

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isVisible()) {
        this.hide();
      }
    };
  }

  show(title: string, content: HTMLElement, getAnchor: AnchorFn): void {
    this.detachOutsidePointer();
    this.titleEl.textContent = title;
    this.bodyEl.innerHTML = '';
    this.bodyEl.appendChild(content);
    this.anchorFn = getAnchor;
    this.el.style.display = 'block';
    this.reposition();
    this.startLoop();
    document.addEventListener('keydown', this.escHandler);
    queueMicrotask(() => {
      if (!this.isVisible()) return;
      this.outsidePointerHandler = (e: PointerEvent) => {
        const t = e.target as Node | null;
        if (t && !this.el.contains(t)) this.hide();
      };
      document.addEventListener('pointerdown', this.outsidePointerHandler, true);
    });
  }

  hide(): void {
    if (!this.isVisible()) return;
    this.detachOutsidePointer();
    this.el.style.display = 'none';
    this.stopLoop();
    document.removeEventListener('keydown', this.escHandler);
    this._onClose?.();
  }

  private detachOutsidePointer(): void {
    if (this.outsidePointerHandler) {
      document.removeEventListener('pointerdown', this.outsidePointerHandler, true);
      this.outsidePointerHandler = null;
    }
  }

  isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  set onClose(cb: (() => void) | null) {
    this._onClose = cb;
  }

  setTemporaryHidden(hidden: boolean): void {
    this.el.style.visibility = hidden ? 'hidden' : 'visible';
  }

  destroy(): void {
    this.detachOutsidePointer();
    this.hide();
    this.el.remove();
  }

  private startLoop(): void {
    const tick = () => {
      if (!this.isVisible()) return;
      this.reposition();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private reposition(): void {
    if (!this.anchorFn) return;
    const { x, y } = this.anchorFn();

    const virtualEl = {
      getBoundingClientRect: () => ({
        x,
        y,
        width: 0,
        height: 0,
        top: y,
        left: x,
        right: x,
        bottom: y,
      }),
    };

    computePosition(virtualEl, this.el, {
      placement: 'top',
      middleware: [
        offset(40),
        autoPlacement({ allowedPlacements: ['top', 'bottom', 'left', 'right'] }),
        shift({ padding: 12 }),
      ],
    }).then(({ x: px, y: py }) => {
      this.el.style.left = `${px}px`;
      this.el.style.top = `${py}px`;
    });
  }
}
