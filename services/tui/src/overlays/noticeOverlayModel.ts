import type { TuiSessionState } from '../session/sessionController';
import { truncateTerminalLine, wrapTerminalText } from '../text/terminalText';

export type NoticeOverlayState =
  | { phase: 'closed' }
  | {
      phase: 'interrupting';
      requestId: string;
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
        };
  }
  if (state.phase === 'interrupting') {
    return createNoticeOverlayState();
  }
  if (
    state.phase === 'closed'
    && (
      sessionState.connection === 'error'
      || sessionState.connection === 'disconnected'
    )
  ) {
    return {
      phase: 'error',
      source: 'connection',
      message: sessionState.connectionDetail
        ?? 'local-agent is unavailable',
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

export function closeNoticeOverlay(): NoticeOverlayState {
  return createNoticeOverlayState();
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
        'Stopping the active response…',
        '',
        `request: ${state.requestId}`,
        '',
        'Timeline updates remain ordered while the host settles.',
      ].map((line) => truncateTerminalLine(line, innerWidth)).join('\n'),
    };
  }
  return {
    title: ' Error ',
    bottomTitle: ' Enter/Esc dismiss ',
    content: wrapTerminalText(state.message, innerWidth, 5).join('\n'),
  };
}
