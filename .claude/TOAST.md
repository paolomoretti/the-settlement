# Toast Notifications

Short-lived messages displayed at the top-center of the screen. Use toasts to confirm player actions ("Game saved") or surface brief feedback ("Building deleted").

## How to Use

```typescript
// Option A — direct import (from UI code that already imports modules)
import { showToast } from '@/ui/Toast';
showToast('Game saved!');

showToast('Game saved', {
  duration: 5000,
  messageAsButton: true,
  action: {
    label: '✎',
    title: 'Pick save slot',
    onClick: () => saveSession.openSaveDialog(undefined, 'Save As — pick a slot'),
  },
});

// Option B — via EventBus (from any system, no import needed)
import { eventBus } from '@/core/EventBus';
eventBus.emit('toast', { message: 'Game saved!' });
```

Option B works because `setupToastListener()` is called once during game UI init and subscribes to the `'toast'` event.

## Behavior

- Appears at top-center of the screen, stacked vertically if multiple fire at once
- Fades in over 400ms, stays visible for 2 seconds, then fades out over 400ms
- Pauses its dismissal countdown while hovered
- Can render a single action button; save success uses a 5-second toast with a pencil action for picking another save slot
- Retro squared style: dark background, green border, yellow monospace text

## Files

- `src/ui/Toast.ts` — `showToast()` function and EventBus listener setup
- `index.html` — `#toast-container` and `.toast` CSS styles

## When to Use

- Player action confirmations: save, load, delete
- Mode feedback that doesn't fit in the status bar
- Brief error messages for non-critical failures

Do **not** use toasts for information the player needs to act on — use a dialog or popover instead.
