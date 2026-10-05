import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// This deliberately supports only the selected, axis-aligned primary mark.
// Reject unsupported SVG changes rather than silently changing the TUI logo.
const source = new URL('../../../assets/brand/pinpawo-primary-black.svg', import.meta.url);
const output = new URL('../src/welcome/primaryLogo.generated.ts', import.meta.url);
const svg = readFileSync(source, 'utf8');
if (!svg.includes('viewBox="0 0 12 12"')) throw new Error('Unexpected primary mark viewBox');
if (/\b(?:transform|rx|ry)=|<(?:use|circle|ellipse)\b/.test(svg)) {
  throw new Error('Primary mark contains unsupported transformed or rounded geometry');
}
const group = svg.match(/<g shape-rendering="crispEdges">(.*?)<\/g>/)?.[1];
if (!group) throw new Error('Primary mark geometry is missing');
type Point = readonly [number, number];
const polygons: Point[][] = [];
let remainder = group.replace(/<rect\s+([^>]+)\/>/g, (_, attributes: string) => {
  const value = (key: string) => {
    const raw = attributes.match(new RegExp(`\\b${key}="([\\d.]+)"`))?.[1];
    if (raw === undefined) throw new Error(`Missing rectangle ${key}`);
    return Number(raw);
  };
  const x = value('x'); const y = value('y');
  const width = value('width'); const height = value('height');
  polygons.push([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
  return '';
});
remainder = remainder.replace(/<path d="([^"]+)"\/>/g, (_, path: string) => {
  if (!/^(?:M[\d.]+ [\d.]+)(?:[HV][\d.]+)+Z$/.test(path)) {
    throw new Error('Primary mark must contain only an axis-aligned polygon');
  }
  const tokens = path.match(/[MHVZ]|[\d.]+/g)!;
  const points: Point[] = []; let x = 0; let y = 0;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    if (command === 'Z') break;
    if (command === 'M') { x = Number(tokens[i++]!); y = Number(tokens[i++]!); }
    if (command === 'H') x = Number(tokens[i++]!);
    if (command === 'V') y = Number(tokens[i++]!);
    points.push([x, y]);
  }
  polygons.push(points);
  return '';
});
if (remainder.trim() || polygons.length !== 5) throw new Error('Unexpected primary mark shapes');
for (const points of polygons) {
  if (points.some(([x, y]) => x < 0 || x > 12 || y < 0 || y > 12 || !Number.isInteger(x * 2) || !Number.isInteger(y * 2))) {
    throw new Error('Primary mark must fit its half-unit grid');
  }
}
function inside(x: number, y: number, polygon: readonly Point[]) {
  let filled = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i]!; const [bx, by] = polygon[j]!;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) filled = !filled;
  }
  return filled;
}
const pixel = (column: number, halfRow: number) => polygons.some((polygon) =>
  inside((column + 0.5) / 2, (halfRow + 0.5) / 2, polygon),
);
// One character is half a square unit wide and one unit tall. Half blocks
// preserve the selected 0.5-unit toe/pad gap at the usual 1:2 cell aspect.
const lines = Array.from({ length: 12 }, (_, row) => Array.from({ length: 24 }, (_, column) => {
  const top = pixel(column, row * 2); const bottom = pixel(column, row * 2 + 1);
  return top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
}).join(''));
const generated = `// Generated from assets/brand/pinpawo-primary-black.svg. Do not edit.\n// Run npm run brand:generate -w @pinpawo/tui after changing the source.\nexport const PRIMARY_LOGO_SOURCE_SHA256 = '${createHash('sha256').update(svg).digest('hex')}';\nexport const PRIMARY_LOGO_LINES = [\n${lines.map((line) => `  '${line}',`).join('\n')}\n] as const;\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('Welcome logo drifted from the primary SVG; run brand:generate');
  console.log('Welcome logo matches the primary SVG');
} else {
  writeFileSync(output, generated);
}
