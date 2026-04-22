/**
 * Axis-aligned segment on the square grid (cardinal line only).
 * Used for straight road rows (Shift + drag).
 */
export function axisAlignedGridLine(
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    for (let x = x0; x <= x1; x++) {
      cells.push({ x, y: ay });
    }
  } else {
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    for (let y = y0; y <= y1; y++) {
      cells.push({ x: ax, y });
    }
  }
  return cells;
}
