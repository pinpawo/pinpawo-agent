import type { AgentSession } from '@pinpawo/agent-session';
import type {
  TuiConnectionStatus,
  TuiSessionState,
} from '../session/sessionController';

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');

export function formatHeader(state: TuiSessionState) {
  const model = state.session.runtime?.model?.trim();
  return [
    'PinPawo TUI v2',
    formatConnection(state.connection),
    ...(model ? [model] : []),
  ].join(' · ');
}

export function formatStatusLine(state: TuiSessionState) {
  if (state.connectionDetail && state.connection !== 'ready') {
    return state.connectionDetail;
  }
  const session = state.session;
  return [
    ...(state.connectionDetail ? [state.connectionDetail] : []),
    formatUsage(session),
    ...(session.runtime?.cwd ? [compactPath(session.runtime.cwd)] : []),
  ].join(' · ');
}

export function formatConnection(status: TuiConnectionStatus) {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'ready':
      return 'connected';
    case 'disconnected':
      return 'disconnected';
    case 'error':
      return 'error';
  }
}

export function formatUsage(session: AgentSession) {
  const usage = session.sessionTokenUsage ?? session.tokenUsage;
  const contextWindow = usage?.contextWindow ?? session.runtime?.contextWindow;
  if (!usage) {
    return contextWindow
      ? `in/out: –/– · context: ${formatCount(contextWindow)}`
      : 'in/out: –/–';
  }
  const latestInput = usage.latestInputTokens;
  const remaining = latestInput !== undefined && contextWindow
    ? Math.max(0, contextWindow - latestInput)
    : null;
  return [
    `in/out: ${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`,
    ...(remaining !== null ? [`context: ${formatCount(remaining)} left`] : []),
  ].join(' · ');
}

function compactPath(path: string) {
  const pieces = path.split(/[\\/]/).filter(Boolean);
  if (pieces.length <= 2) return path;
  return `…/${pieces.slice(-2).join('/')}`;
}

function formatCount(value: number) {
  return COUNT_FORMATTER.format(Math.max(0, Math.round(value)));
}
