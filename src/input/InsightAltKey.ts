/**
 * Tracks Left/Right Alt (macOS Option) for map insight mode (grid + hover highlights + tooltips).
 * Listeners use capture so canvas/game focus is not required.
 */

let insightAltHeld = false;
let listenersRegistered = false;

export function isInsightAltHeld(): boolean {
  return insightAltHeld;
}

export function registerInsightAltKeyListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const setFromKey = (e: KeyboardEvent, down: boolean): void => {
    if (e.code === 'AltLeft' || e.code === 'AltRight') {
      insightAltHeld = down;
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => setFromKey(e, true);
  const onKeyUp = (e: KeyboardEvent): void => setFromKey(e, false);

  const reset = (): void => {
    insightAltHeld = false;
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', reset);
}
