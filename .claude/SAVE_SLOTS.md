# Save Slots

Save slots are managed by `src/save/GameSaveSession.ts`.

- Slot data is stored in `localStorage` under `settler_save_<index>`.
- The active resume pointer is stored under `settler_last_save_slot`.
- `saveToSlot(index, name, opts)` writes the current game data, updates the resume pointer, and notifies `onSlotsChanged`. `opts.manual: false` marks autosave-created slots so the first explicit Save on a new game still opens the picker.
- `hasManualSaveSlot()` returns true only when the current slot was manually picked by the player. Legacy slots without a `manual` flag count as manual.
- `clearSlot(index)` removes the slot from `localStorage`. If it clears the active or resume slot, it also clears `settler_last_save_slot` and unbinds `currentSlot` so autosave/quick save does not silently recreate the deleted slot.
- Save and load dialogs both render a clear icon for filled slots. Clicking it refreshes the slot list in place and updates the welcome Load button through `onSlotsChanged`.
- The dock no longer has a Save As button. Successful manual saves use a 5-second `showSaveToast()` with a pencil action that opens the save slot picker.
