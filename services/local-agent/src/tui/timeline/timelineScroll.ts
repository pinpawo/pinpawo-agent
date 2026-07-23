export type TimelineScrollState = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
};

export type TimelineScrollDirection = 'up' | 'down';

export function createTimelineScrollState(): TimelineScrollState {
  return {
    offset: 0,
    contentHeight: 0,
    viewportHeight: 0,
  };
}

export function updateTimelineScrollMetrics(
  state: TimelineScrollState,
  metrics: {
    contentHeight: number;
    viewportHeight: number;
  },
): TimelineScrollState {
  const contentHeight = Math.max(0, Math.floor(metrics.contentHeight));
  const viewportHeight = Math.max(0, Math.floor(metrics.viewportHeight));
  const maxOffset = maxTimelineScrollOffset(contentHeight, viewportHeight);
  const offset = Math.min(state.offset, maxOffset);

  if (
    state.offset === offset
    && state.contentHeight === contentHeight
    && state.viewportHeight === viewportHeight
  ) {
    return state;
  }

  return {
    offset,
    contentHeight,
    viewportHeight,
  };
}

export function scrollTimelineByPage(
  state: TimelineScrollState,
  direction: TimelineScrollDirection,
): TimelineScrollState {
  const pageSize = Math.max(1, state.viewportHeight - 1);
  return scrollTimelineByLines(state, direction, pageSize);
}

export function scrollTimelineByLines(
  state: TimelineScrollState,
  direction: TimelineScrollDirection,
  lineCount: number,
): TimelineScrollState {
  const distance = Math.max(1, Math.floor(lineCount));
  const maxOffset = maxTimelineScrollOffset(state.contentHeight, state.viewportHeight);
  const offset = direction === 'up'
    ? Math.min(maxOffset, state.offset + distance)
    : Math.max(0, state.offset - distance);

  return offset === state.offset ? state : { ...state, offset };
}

export function maxTimelineScrollOffset(contentHeight: number, viewportHeight: number) {
  return Math.max(0, contentHeight - viewportHeight);
}
