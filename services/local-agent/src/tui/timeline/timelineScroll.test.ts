import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTimelineScrollState,
  scrollTimelineByLines,
  scrollTimelineByPage,
  updateTimelineScrollMetrics,
} from './timelineScroll';

test('timeline scrolling pages away from and back to the live tail', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 50,
    viewportHeight: 10,
  });

  state = scrollTimelineByPage(state, 'up');
  assert.equal(state.offset, 9);
  state = scrollTimelineByPage(state, 'up');
  assert.equal(state.offset, 18);
  state = scrollTimelineByPage(state, 'down');
  assert.equal(state.offset, 9);
  state = scrollTimelineByPage(state, 'down');
  assert.equal(state.offset, 0);
});

test('timeline scrolling clamps to content and resize boundaries', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 12,
    viewportHeight: 5,
  });
  state = scrollTimelineByPage(state, 'up');
  state = scrollTimelineByPage(state, 'up');
  assert.equal(state.offset, 7);

  state = updateTimelineScrollMetrics(state, {
    contentHeight: 12,
    viewportHeight: 10,
  });
  assert.equal(state.offset, 2);
});

test('timeline wheel scrolling moves a small line increment', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 50,
    viewportHeight: 10,
  });

  state = scrollTimelineByLines(state, 'up', 3);
  assert.equal(state.offset, 3);
  state = scrollTimelineByLines(state, 'down', 3);
  assert.equal(state.offset, 0);
});
