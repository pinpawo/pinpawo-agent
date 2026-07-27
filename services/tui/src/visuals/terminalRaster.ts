const UPPER_HALF_BLOCK = '▀';
const LOWER_HALF_BLOCK = '▄';
const FULL_BLOCK = '█';

export function renderHalfBlockRaster(
  rows: readonly string[],
  filledCell = '#',
): string[] {
  if (rows.length === 0) return [];
  const width = rows[0]?.length ?? 0;
  if (width === 0) return [];
  if (filledCell.length !== 1) {
    throw new Error('filledCell must be one character');
  }
  if (rows.some((row) => row.length !== width)) {
    throw new Error('raster rows must have equal width');
  }

  let minX = width;
  let maxX = -1;
  let minY = rows.length;
  let maxY = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) {
      if (row[x] !== filledCell) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  if (maxX < minX || maxY < minY) return [];

  const output: string[] = [];
  for (let y = minY; y <= maxY; y += 2) {
    const top = rows[y] ?? '';
    const bottom = rows[y + 1] ?? '';
    let line = '';
    for (let x = minX; x <= maxX; x += 1) {
      const topFilled = top[x] === filledCell;
      const bottomFilled = bottom[x] === filledCell;
      line += topFilled && bottomFilled
        ? FULL_BLOCK
        : topFilled
          ? UPPER_HALF_BLOCK
          : bottomFilled
            ? LOWER_HALF_BLOCK
            : ' ';
    }
    output.push(line);
  }
  return output;
}
