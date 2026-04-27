# Military Attacks

Enemy attacks are a runtime-only first pass for conquering enemy realm targets.

## Target Rules

- Enemy civilian buildings are not selectable.
- Enemy military buildings and enemy headquarters are selectable when the clicked tile is explored.
- Enemy headquarters can be attacked even while enemy military buildings still exist.
- Player soldiers can join an attack from player military buildings within Chebyshev distance `<= 40` cells of the target building center.

## Attack UI

Enemy attack targets open an attack-only popover instead of the normal building controls.

- Rank 1, Rank 2, and Rank 3 rows expose plus/minus controls.
- Each row is capped by available garrisoned soldiers in range.
- The Attack button stays disabled until at least one soldier is selected.

## Runtime Flow

Attacks are stored in memory on `Game` and are not serialized. Saving mid-attack only persists any building/garrison changes that have already resolved.

1. `startEnemyAttack()` validates the target and selected ranks.
2. Selected soldiers are removed from their source garrison slots and revealed as visible military workers. Their source post is considered "on campaign" and does not auto-train replacements until the attack resolves.
3. Defenders are removed from the target garrison and revealed.
4. Both sides march off-road to staging tiles near the target.
5. Combat runs as sequential one-on-one duels.

Each duel lasts 10 seconds. One attacker and one defender animate in a combat pose; rank-weighted random rolls decide the loser. The loser lies down for about 2 seconds and fades out, while the survivor stays up and faces the next opponent.

Duelists are snapped to close fractional-tile face-off positions while fighting so the sword/shield animation reads as contact instead of two distant walkers.

Rank weights:

- Rank 1: `1`
- Rank 2: `1.6`
- Rank 3: `2.4`

## Conquest

If all attackers die, surviving defenders are restored to the target garrison and ownership does not change.

Attack result toasts stay visible for 10 seconds and include a jump action that centers the camera on the fight location.

If attackers survive:

- Captured enemy military buildings transfer to the player.
- Surviving attackers visibly walk into the captured building before being hidden in its garrison. If more attackers survive than the captured post can hold, the overflow soldiers walk back to their original military building.
- Player territory is finalized after the first surviving attacker enters the captured post. From that point the captured post holds its ground until another force conquers it, even if its soldiers later march out or die elsewhere.
- Enemy non-military buildings inside the newly owned territory cells burn after that final territory recalculation. This includes the new cordon/frontier cells so captured posts carve out a clear local block of land.
- Storage and output-buffer goods from burned enemy civilian buildings are dropped on the former building entrance/footprint cell for player pickup when possible.
- Enemy workers tied to burned buildings retreat toward their headquarters when possible; otherwise they are removed.

Enemy headquarters are military control points, not civilian burn targets. Capturing an enemy headquarters transfers its ownership to the player and leaves its storage in place, so it becomes a secondary player-owned storehouse. Surviving enemy military buildings remain enemy-owned and keep projecting territory until conquered separately.

Automatic soldier/gold dispatch only targets player-owned military buildings. Enemy military buildings must be conquered before the player HQ can refill or pay their garrisons.

When defenders win, surviving defenders visibly walk back into their military building before being hidden again.
