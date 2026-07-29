import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHalfBlockRaster } from './terminalRaster';

test('half-block raster combines square cells without gaps', () => {
  assert.deepEqual(renderHalfBlockRaster([
    '.##.',
    '####',
    '.##.',
  ]), [
    '▄██▄',
    ' ▀▀ ',
  ]);
});

test('half-block raster validates one rectangular character grid', () => {
  assert.deepEqual(renderHalfBlockRaster(['....']), []);
  assert.throws(
    () => renderHalfBlockRaster(['##', '#']),
    /equal width/,
  );
  assert.throws(
    () => renderHalfBlockRaster(['##'], '##'),
    /one character/,
  );
});
