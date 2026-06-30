import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTuiTimelineViewMode,
  parseTuiTimelineViewMode,
} from './timelineView';

test('timeline view helpers parse command aliases and labels', () => {
  assert.equal(parseTuiTimelineViewMode('snapshot'), 'snapshot');
  assert.equal(parseTuiTimelineViewMode('chat'), 'snapshot');
  assert.equal(parseTuiTimelineViewMode('process'), 'process');
  assert.equal(parseTuiTimelineViewMode('ops'), 'process');
  assert.equal(parseTuiTimelineViewMode('unknown'), null);

  assert.equal(formatTuiTimelineViewMode('snapshot'), '对话');
  assert.equal(formatTuiTimelineViewMode('process'), '过程');
});
