import type { TuiSessionState } from '../session/sessionController';
import { truncateTerminalLine, wrapTerminalText } from '../text/terminalText';

export type NoticeOverlayState =
  | {
      phase: 'closed';
      dismissedConnectionError?: string;
    }
  | {
      phase: 'interrupting';
      requestId: string;
      pendingTooLong: boolean;
    }
  | {
      phase: 'error';
      source: 'connection' | 'local';
      message: string;
    };

export type NoticeOverlayAction = 'close' | null;

export function createNoticeOverlayState(): NoticeOverlayState {
  return { phase: 'closed' };
}

export function syncNoticeOverlay(
  state: NoticeOverlayState,
  sessionState: TuiSessionState,
): NoticeOverlayState {
  const run = sessionState.session.activeRun;
  if (run?.state === 'interrupting') {
    return state.phase === 'interrupting' && state.requestId === run.requestId
      ? state
      : {
          phase: 'interrupting',
          requestId: run.requestId,
          pendingTooLong: false,
        };
  }
  if (state.phase === 'interrupting') {
    return createNoticeOverlayState();
  }
  if (
    state.phase === 'closed'
    && state.dismissedConnectionError
    && sessionState.connection === 'ready'
  ) {
    return createNoticeOverlayState();
  }
  if (
    state.phase === 'closed'
    && (
      sessionState.connection === 'error'
      || sessionState.connection === 'disconnected'
    )
  ) {
    const message = sessionState.connectionDetail
      ?? 'local-agent is unavailable';
    if (state.dismissedConnectionError === message) {
      return state;
    }
    return {
      phase: 'error',
      source: 'connection',
      message,
    };
  }
  if (
    state.phase === 'error'
    && state.source === 'connection'
    && sessionState.connection === 'ready'
  ) {
    return createNoticeOverlayState();
  }
  return state;
}

export function openErrorNotice(message: string): NoticeOverlayState {
  return {
    phase: 'error',
    source: 'local',
    message: message.trim() || 'An unexpected error occurred.',
  };
}

export function closeNoticeOverlay(
  state: NoticeOverlayState = createNoticeOverlayState(),
): NoticeOverlayState {
  return state.phase === 'error' && state.source === 'connection'
    ? {
        phase: 'closed',
        dismissedConnectionError: state.message,
      }
    : createNoticeOverlayState();
}

export function resolveNoticeOverlayKey(
  state: NoticeOverlayState,
  key: { name: string },
): NoticeOverlayAction {
  if (state.phase !== 'error') return null;
  return key.name === 'escape' || key.name === 'return'
    ? 'close'
    : null;
}

export function shouldRestoreComposerAfterNoticeSync(
  previous: NoticeOverlayState,
  next: NoticeOverlayState,
) {
  return previous.phase !== 'closed' && next.phase === 'closed';
}

export function markInterruptNoticePendingTooLong(
  state: NoticeOverlayState,
  requestId: string,
): NoticeOverlayState {
  if (
    state.phase !== 'interrupting'
    || state.requestId !== requestId
    || state.pendingTooLong
  ) {
    return state;
  }
  return {
    ...state,
    pendingTooLong: true,
  };
}

export function buildNoticeOverlayViewModel(
  state: Exclude<NoticeOverlayState, { phase: 'closed' }>,
  width: number,
) {
  const innerWidth = Math.max(1, width - 4);
  if (state.phase === 'interrupting') {
    return {
      title: ' Interrupting ',
      bottomTitle: ' Ctrl+C again to exit ',
      content: [
        state.pendingTooLong
          ? 'Still stopping; the agent has not confirmed yet.'
          : 'Stopping the active response…',
        '',
        `request: ${state.requestId}`,
        '',
        state.pendingTooLong
          ? 'Input remains locked until the host settles.'
          : 'Timeline updates remain ordered while the host settles.',
      ].map((line) => truncateTerminalLine(line, innerWidth)).join('\n'),
    };
  }
  return {
    title: ' Error ',
    bottomTitle: ' Enter/Esc dismiss ',
    content: wrapTerminalText(state.message, innerWidth, 5).join('\n'),
  };
}
