import { eventBus } from '@/core/EventBus';

const TOAST_DURATION = 2000;
const FADE_DURATION = 400;

let containerEl: HTMLElement | null = null;

function getContainer(): HTMLElement {
  if (containerEl) return containerEl;

  containerEl = document.createElement('div');
  containerEl.id = 'toast-container';
  document.getElementById('ui-overlay')?.appendChild(containerEl);
  return containerEl;
}

export function showToast(message: string): void {
  const container = getContainer();

  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('visible'));

  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), FADE_DURATION);
  }, TOAST_DURATION);
}

export function setupToastListener(): void {
  eventBus.on('toast', (data: { message: string }) => {
    showToast(data.message);
  });
}
