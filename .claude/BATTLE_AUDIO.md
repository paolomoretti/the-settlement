# Battle audio

Battle sounds are loaded in `Game` through `AudioManager` and use files under `public/audio/`.

## Sound assets

- `battle_clash_1.mp3`
- `battle_clash_2.mp3`
- `battle_victory.mp3`
- `battle_loss.mp3`

## Runtime behavior

- **Clash loop while watching a duel:** when at least one active attack is in `duel` phase and visible to the player, the game plays a random clash sound (`battle_clash_1` or `battle_clash_2`) on a randomized cadence. Delays are usually around 0.7-1.6s, with occasional quick follow-up hits for short "couple of strikes" moments.
- **Outcome cue:** when a battle resolves, the game plays `battle_victory` if the player side wins, or `battle_loss` if the player side loses.
- **Visibility gate:** both clash and outcome sounds only play when the battle is currently visible (battle point is explored and on-screen in the active camera view).

## Notes

- This system is scoped to military attack duels (`ActiveEnemyAttack`) and does not play for off-screen battles.
- Asset filenames should stay stable because `Game` loads these explicit `/audio/...` paths during initialization.
