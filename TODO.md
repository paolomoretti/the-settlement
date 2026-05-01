# The Settlement — To-Do

A running list of things to build, fix, or improve. Check items off as they land, add new ones any time.

---

## 🎮 Gameplay systems

- [ ] Resource consumption — workers/population consume food over time
- [ ] Mine food system — mines accept bread / fish / ham as OR-input to keep operating
- [ ] Tool requirements for workers — workers need the right tool before they can staff a building
- [ ] Metalworks tool priority system — weighted dispatch order for which tools get produced first
- [ ] Worker job assignment UI — manually assign / reassign workers to buildings
- [ ] Trading — exchange resources with neutral merchants or enemy factions
- [ ] Building upgrades — e.g. Hut → House already wired, extend to other tiers

---

## 🖥️ UI / UX

- [ ] Production UX indicators — per-building stop/pickup toggle icons and progress bars
- [ ] In-game help / controls overlay — surfacing the Alt insight mode, road planning, etc.

---

## 🎨 Art & audio

- [ ] Audio — sound effects and ambient tracks via Howler.js (stubs exist, need assets + wiring)
- [ ] Weather / seasons — visual pass (snow, rain) and optional production modifiers
- [ ] Remaining building sprites — any buildings still using placeholder colour blocks

---

## 🐛 Debug / tooling

- [ ] Chimney smoke positions — audit all buildings in `debug.html` smoke column and paste tuned values into `buildings.json`

---

## ✅ Done

- [x] Prettier + EditorConfig + VS Code / Cursor / Zed format-on-save
- [x] debug.html smoke preview column with live JSON editor
- [x] debug.html construction animation forward-only (fixed reverse order)
- [x] debug.html all sprite columns equal width
