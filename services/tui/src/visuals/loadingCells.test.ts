import assert from 'node:assert/strict';
import test from 'node:test';
import { RGBA } from '@opentui/core';
import {
  buildLoadingCellLine,
  LOADING_CELL_FRAME_COUNT,
  LOADING_CELL_WIDTH,
  loadingCellFrame,
} from './loadingCells';

test('loading animation uses one shared terminal-cell raster', () => {
  assert.equal(LOADING_CELL_FRAME_COUNT, 4);
  assert.equal(LOADING_CELL_WIDTH, 3);
  assert.deepEqual(loadingCellFrame(0), [true, false, false]);
  assert.deepEqual(loadingCellFrame(1), [false, true, false]);
  assert.deepEqual(loadingCellFrame(4), loadingCellFrame(0));

  const first = buildLoadingCellLine('waiting', 0, { prefix: 'live · ' });
  const second = buildLoadingCellLine('waiting', 1, { prefix: 'live · ' });
  assert.equal(first.chunks.map((chunk) => chunk.text).join(''), 'live ·     waiting');
  assert.ok(first.chunks[1]?.bg?.equals(RGBA.fromHex('#69c0c8')));
  assert.ok(first.chunks[2]?.bg?.equals(RGBA.fromHex('#30484b')));
  assert.ok(second.chunks[1]?.bg?.equals(RGBA.fromHex('#30484b')));
  assert.ok(second.chunks[2]?.bg?.equals(RGBA.fromHex('#69c0c8')));
});
