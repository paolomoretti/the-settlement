# Game Speed

Fast-forward is a full gameplay simulation toggle controlled by the top-right `#btn-fast-forward` button. Normal speed is `1x`; fast-forward uses `3x`.

## Simulation Clock

- `src/core/Game.ts` owns `simulationNowMs` and advances it from the real `requestAnimationFrame` delta multiplied by the current time scale.
- `src/core/simulationClock.ts` exposes the current simulation timestamp to components and systems that need absolute gameplay time.
- Systems still use real frame timing for `requestAnimationFrame` cadence and FPS display, but gameplay updates receive scaled `deltaTime`.

## What Scales

Fast-forward affects construction, building production, movement, transport rechecks, worker dispatch waits, production animation waits, wildlife spawn/wander/jumps, survey digging/labels/cooldowns, demolition fires/scorches, well depletion demolition, water fish regen/jumps, enemy pressure/road maintenance, battle duel cadence, and battle clash cadence.

## What Stays Wall-Clock

UI/runtime timers stay on real time: toasts, autosave intervals/debounces, loading-screen dwell, save-slot timestamps, road segment recalculation debounce, erase smoke, and debug-only presentation timers.

## Saves

Saves include `simulationNowMs` so gameplay timestamps remain coherent across reloads. Older saves without a simulation clock load with the current wall-clock timestamp, which preserves legacy timer ages without creating future/negative ages.
