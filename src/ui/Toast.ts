import { eventBus } from '@/core/EventBus';

const TOAST_DURATION = 2000;
const FADE_DURATION = 400;

let containerEl: HTMLElement | null = null;

export interface ToastAction {
  label: string;
  title: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
  messageAsButton?: boolean;
}

function getContainer(): HTMLElement {
  if (containerEl) return containerEl;

  containerEl = document.createElement('div');
  containerEl.id = 'toast-container';
  document.getElementById('ui-overlay')?.appendChild(containerEl);
  return containerEl;
}

export function showToast(message: string, options: ToastOptions = {}): void {
  const container = getContainer();

  const el = document.createElement('div');
  el.className = 'toast';

  if (options.messageAsButton) {
    const messageBtn = document.createElement('button');
    messageBtn.type = 'button';
    messageBtn.className = 'toast-message-btn';
    messageBtn.textContent = message;
    messageBtn.setAttribute('aria-disabled', 'true');
    messageBtn.tabIndex = -1;
    el.appendChild(messageBtn);
  } else {
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    el.appendChild(text);
  }

  if (options.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action-btn';
    action.textContent = options.action.label;
    action.title = options.action.title;
    action.setAttribute('aria-label', options.action.title);
    action.addEventListener('click', e => {
      e.stopPropagation();
      options.action?.onClick();
      dismiss();
    });
    el.appendChild(action);
  }

  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('visible'));

  const duration = options.duration ?? TOAST_DURATION;
  let remaining = duration;
  let startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let isDismissing = false;

  function dismiss(): void {
    if (isDismissing) return;
    isDismissing = true;
    remaining = 0;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    el.classList.remove('visible');
    setTimeout(() => el.remove(), FADE_DURATION);
  }

  function scheduleDismiss(): void {
    if (isDismissing) return;
    startedAt = Date.now();
    timeoutId = setTimeout(dismiss, remaining);
  }

  el.addEventListener('mouseenter', () => {
    if (isDismissing || timeoutId === null) return;
    clearTimeout(timeoutId);
    timeoutId = null;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  });

  el.addEventListener('mouseleave', () => {
    if (isDismissing || timeoutId !== null || remaining <= 0) return;
    scheduleDismiss();
  });

  scheduleDismiss();
}

export function setupToastListener(): void {
  eventBus.on('toast', (data: { message: string } & ToastOptions) => {
    showToast(data.message, data);
  });
}
