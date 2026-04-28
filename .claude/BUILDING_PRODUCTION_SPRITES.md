# Building production sprite animation

Production facade sprites (`*_prod_*`) are configured in `src/catalog/buildingSprites.ts`.

## Data

- `BUILDING_PRODUCTION_SPRITES`: maps building id -> sprite frame paths.
- `BUILDING_PRODUCTION_SPRITE_ANIMATION`: optional per-building behavior:
  - `activeFraction` (0..1): how much of each production cycle uses production sprites.
  - `sequence`: optional list of sprite indices (`0..n`) or `null`.
    - `null` means "show final (idle/completed) building sprite" for that step.
    - Sequence steps are distributed evenly across the `activeFraction`.

If no animation config is provided for a building, production frames are spread linearly across the full cycle.

## Bakery example

Bakery uses:

- `activeFraction: 0.55`
- a custom sequence with short runs (`0,1,2,1,0`) and `null` pauses

This gives quick fire bursts, then brief quiet periods, instead of a smooth continuous loop.
