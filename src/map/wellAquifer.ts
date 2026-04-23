/** Inclusive bounds for lazy underground water when a well finishes construction on a cell. */
export const WELL_AQUIFER_MIN = 15;
export const WELL_AQUIFER_MAX = 50;

export function rollWellAquiferCapacity(): number {
  return WELL_AQUIFER_MIN + Math.floor(Math.random() * (WELL_AQUIFER_MAX - WELL_AQUIFER_MIN + 1));
}

/** First well completion on this cell: roll capacity. No-op if already assigned (including `0`). */
export function ensureWellAquiferInitialized(tile: { cellWellWaterRemaining?: number } | null | undefined): void {
  if (!tile || tile.cellWellWaterRemaining !== undefined) return;
  tile.cellWellWaterRemaining = rollWellAquiferCapacity();
}
