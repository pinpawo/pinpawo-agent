export type TimelineScrollState = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
  followingTail: boolean;
};

export type TimelineScrollDirection = 'up' | 'down';

export function createTimelineScrollState(): TimelineScrollState {
  return {
    offset: 0,
    contentHeight: 0,
    viewportHeight: 0,
    followingTail: true,
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
  const contentGrowth = contentHeight - state.contentHeight;
  const viewportGrowth = viewportHeight - state.viewportHeight;
  const anchoredOffset = state.followingTail
    ? 0
    : state.offset + contentGrowth - viewportGrowth;
  const offset = Math.max(0, Math.min(anchoredOffset, maxOffset));

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
    followingTail: state.followingTail,
  };
}

export function scrollTimelineByPage(
  state: TimelineScrollState,
  direction: TimelineScrollDirection,
): TimelineScrollState {
  const pageSize = Math.max(1, state.viewportHeight - 1);
  const maxOffset = maxTimelineScrollOffset(state.contentHeight, state.viewportHeight);
  const offset = direction === 'up'
    ? Math.min(maxOffset, state.offset + pageSize)
    : Math.max(0, state.offset - pageSize);
  const followingTail = direction === 'up' ? false : state.followingTail;

  return offset === state.offset && followingTail === state.followingTail
    ? state
    : { ...state, offset, followingTail };
}

export function maxTimelineScrollOffset(contentHeight: number, viewportHeight: number) {
  return Math.max(0, contentHeight - viewportHeight);
}
