import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHalfBlockRaster } from './terminalRaster';

test('renderHalfBlockRaster packs two square-pixel rows into terminal half blocks', () => {
  assert.deepEqual(renderHalfBlockRaster([
    '.#.',
    '###',
  ]), ['▄█▄']);
  assert.deepEqual(renderHalfBlockRaster([
    '###',
    '.#.',
  ]), ['▀█▀']);
});

test('renderHalfBlockRaster trims an empty raster boundary while preserving shape width', () => {
  assert.deepEqual(renderHalfBlockRaster([
    '.....',
    '..#..',
    '..#..',
    '.....',
  ]), ['█']);
  assert.deepEqual(renderHalfBlockRaster(['....']), []);
});

test('renderHalfBlockRaster rejects malformed input', () => {
  assert.throws(
    () => renderHalfBlockRaster(['##', '#']),
    /equal width/,
  );
  assert.throws(
    () => renderHalfBlockRaster(['##'], '##'),
    /one character/,
  );
});
