import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTimelineScrollState,
  scrollTimelineByLines,
  scrollTimelineByPage,
  updateTimelineScrollMetrics,
} from './timelineScroll';

test('timeline scrolling pages away from and back to the bottom without resuming follow', () => {
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
  assert.equal(state.followingTail, false);

  state = updateTimelineScrollMetrics(state, {
    contentHeight: 54,
    viewportHeight: 10,
  });
  assert.equal(state.offset, 4);
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

test('timeline history remains visually anchored while live content grows', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 50,
    viewportHeight: 10,
  });
  state = scrollTimelineByPage(state, 'up');
  assert.equal(state.offset, 9);

  state = updateTimelineScrollMetrics(state, {
    contentHeight: 54,
    viewportHeight: 10,
  });
  assert.equal(state.offset, 13);
  assert.equal(50 - 10 - 9, 54 - 10 - 13);

  state = updateTimelineScrollMetrics(state, {
    contentHeight: 54,
    viewportHeight: 12,
  });
  assert.equal(state.offset, 11);
  assert.equal(54 - 10 - 13, 54 - 12 - 11);
});

test('timeline wheel scrolling moves a small line increment without resuming follow', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 50,
    viewportHeight: 10,
  });

  state = scrollTimelineByLines(state, 'up', 3);
  assert.equal(state.offset, 3);
  assert.equal(state.followingTail, false);
  state = scrollTimelineByLines(state, 'down', 3);
  assert.equal(state.offset, 0);
  assert.equal(state.followingTail, false);
});

test('timeline continues following the live tail while content grows at offset zero', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 20,
    viewportHeight: 10,
  });
  state = updateTimelineScrollMetrics(state, {
    contentHeight: 30,
    viewportHeight: 10,
  });
  assert.equal(state.offset, 0);
  assert.equal(state.followingTail, true);
});

test('creating scroll state for a new run restores live-tail following', () => {
  let state = updateTimelineScrollMetrics(createTimelineScrollState(), {
    contentHeight: 20,
    viewportHeight: 10,
  });
  state = scrollTimelineByPage(state, 'up');
  assert.equal(state.followingTail, false);

  state = createTimelineScrollState();
  assert.equal(state.offset, 0);
  assert.equal(state.followingTail, true);
});
