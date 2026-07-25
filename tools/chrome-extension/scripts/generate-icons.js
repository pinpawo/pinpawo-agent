import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function colorAt(x, y) {
  if (!insideRoundedRect(x, y, 3, 3, 125, 125, 24)) {
    return [0, 0, 0, 0];
  }

  const background = [62, 38, 112, 255];
  const white = [250, 248, 255, 255];
  const accent = [255, 151, 67, 255];
  const border = 7;
  const insideBrowser = insideRoundedRect(x, y, 20, 25, 108, 103, 13);
  const browserInset = insideRoundedRect(
    x,
    y,
    20 + border,
    25 + border,
    108 - border,
    103 - border,
    8,
  );
  if (insideBrowser && !browserInset) return white;
  if (x >= 24 && x <= 104 && y >= 43 && y <= 49) return white;

  for (const dotX of [34, 46, 58]) {
    const dx = x - dotX;
    const dy = y - 37;
    if (dx * dx + dy * dy <= 10) return accent;
  }

  if (x >= 45 && x <= 83 && y >= 68 && y <= 78) return white;
  for (const centerX of [43, 85]) {
    const dx = x - centerX;
    const dy = y - 73;
    const distance = dx * dx + dy * dy;
    if (distance <= 17 * 17 && distance >= 9 * 9) return accent;
  }
  return background;
}

function createPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const sourceX = ((x + 0.5) * 128) / size;
      const sourceY = ((y + 0.5) * 128) / size;
      const color = colorAt(sourceX, sourceY);
      const offset = rowOffset + 1 + x * 4;
      raw.set(color, offset);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function generateIcons(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([16, 32, 48, 128].map((size) => writeFile(
    resolve(outputDirectory, `icon${size}.png`),
    createPng(size),
  )));
}
