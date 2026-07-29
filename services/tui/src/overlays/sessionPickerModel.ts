import type { AgentSessionSummary } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import { truncateTerminalLine } from '../text/terminalText';

export type SessionPickerPhase =
  | 'closed'
  | 'loading'
  | 'ready'
  | 'resuming'
  | 'error';

export type SessionPickerState = {
  phase: SessionPickerPhase;
  sessions: AgentSessionSummary[];
  selectedIndex: number;
  message?: string;
};

export type SessionPickerAction =
  | 'open'
  | 'close'
  | 'move-up'
  | 'move-down'
  | 'page-up'
  | 'page-down'
  | 'select'
  | null;

export type SessionPickerKey = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
};

const PAGE_SIZE = 5;

export function createSessionPickerState(): SessionPickerState {
  return {
    phase: 'closed',
    sessions: [],
    selectedIndex: 0,
  };
}

export function beginSessionPickerLoad(
  state: SessionPickerState,
): SessionPickerState {
  return {
    phase: 'loading',
    sessions: state.sessions,
    selectedIndex: clampIndex(state.selectedIndex, state.sessions.length),
  };
}

export function loadSessionPickerSessions(
  sessions: AgentSessionSummary[],
): SessionPickerState {
  const firstInactive = sessions.findIndex((session) => !session.active);
  return {
    phase: 'ready',
    sessions,
    selectedIndex: firstInactive >= 0 ? firstInactive : 0,
  };
}

export function failSessionPicker(
  state: SessionPickerState,
  message: string,
): SessionPickerState {
  return {
    ...state,
    phase: 'error',
    message,
  };
}

export function closeSessionPicker(
  state: SessionPickerState,
): SessionPickerState {
  return {
    phase: 'closed',
    sessions: state.sessions,
    selectedIndex: clampIndex(state.selectedIndex, state.sessions.length),
  };
}

export function moveSessionPickerSelection(
  state: SessionPickerState,
  delta: number,
): SessionPickerState {
  if (state.phase !== 'ready' || state.sessions.length === 0) return state;
  return {
    ...state,
    selectedIndex: clampIndex(
      state.selectedIndex + delta,
      state.sessions.length,
    ),
  };
}

export function beginSessionResume(
  state: SessionPickerState,
): SessionPickerState {
  return state.phase === 'ready' && selectedSession(state)
    ? { ...state, phase: 'resuming', message: undefined }
    : state;
}

export function selectedSession(
  state: SessionPickerState,
): AgentSessionSummary | null {
  return state.sessions[state.selectedIndex] ?? null;
}

export function resolveSessionPickerKey(
  state: SessionPickerState,
  key: SessionPickerKey,
): SessionPickerAction {
  if (state.phase === 'closed') {
    return key.ctrl && key.name === 'r' ? 'open' : null;
  }
  if (key.ctrl && key.name === 'c') return null;
  if (state.phase === 'resuming') return null;
  if (key.name === 'escape') return 'close';
  if (state.phase !== 'ready') return null;
  if (key.name === 'up' || key.name === 'k') return 'move-up';
  if (key.name === 'down' || key.name === 'j') return 'move-down';
  if (key.name === 'pageup') return 'page-up';
  if (key.name === 'pagedown') return 'page-down';
  if (key.name === 'return') return 'select';
  return null;
}

export function applySessionPickerAction(
  state: SessionPickerState,
  action: SessionPickerAction,
): SessionPickerState {
  switch (action) {
    case 'close':
      return closeSessionPicker(state);
    case 'move-up':
      return moveSessionPickerSelection(state, -1);
    case 'move-down':
      return moveSessionPickerSelection(state, 1);
    case 'page-up':
      return moveSessionPickerSelection(state, -PAGE_SIZE);
    case 'page-down':
      return moveSessionPickerSelection(state, PAGE_SIZE);
    default:
      return state;
  }
}

export function formatSessionPicker(
  state: SessionPickerState,
  width: number,
  maxRows = 5,
) {
  const innerWidth = Math.max(1, width - 4);
  if (state.phase === 'loading') return 'Loading sessions…';
  if (state.phase === 'error') {
    return truncateTerminalLine(
      `Could not load sessions: ${state.message ?? 'unknown error'}`,
      innerWidth,
    );
  }
  if (state.sessions.length === 0) return 'No sessions to resume.';

  const windowStart = visibleWindowStart(
    state.selectedIndex,
    state.sessions.length,
    maxRows,
  );
  const visible = state.sessions.slice(windowStart, windowStart + maxRows);
  if (state.phase === 'resuming') {
    return truncateTerminalLine(
      `Resuming ${normalizeTitle(selectedSession(state)?.title ?? '')}…`,
      innerWidth,
    );
  }
  return visible.map((session, offset) => {
    const selected = windowStart + offset === state.selectedIndex;
    const prefix = selected ? '› ' : '  ';
    const meta = session.active
      ? `${session.messageCount} · active`
      : `${session.messageCount} · ${formatSessionTime(session.updatedAt)}`;
    const minimumTitleWidth = Math.min(
      16,
      Math.max(4, Math.floor(innerWidth * 0.45)),
    );
    const metaBudget = Math.max(
      0,
      innerWidth - stringWidth(prefix) - minimumTitleWidth - 3,
    );
    const visibleMeta = truncateTerminalLine(meta, metaBudget);
    const suffix = visibleMeta ? ` · ${visibleMeta}` : '';
    const titleBudget = Math.max(
      1,
      innerWidth - stringWidth(prefix) - stringWidth(suffix),
    );
    return `${prefix}${truncateTerminalLine(normalizeTitle(session.title), titleBudget)}${suffix}`;
  }).map((line) => truncateTerminalLine(line, innerWidth)).join('\n');
}

function visibleWindowStart(
  selectedIndex: number,
  sessionCount: number,
  maxRows: number,
) {
  const normalizedRows = Math.max(1, maxRows);
  return Math.min(
    Math.max(0, selectedIndex - normalizedRows + 1),
    Math.max(0, sessionCount - normalizedRows),
  );
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

function normalizeTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim() || 'Untitled session';
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
