import type { AgentSession } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import {
  COMPOSER_PLACEHOLDER,
  STUDIO_COMPOSER_PLACEHOLDER,
} from '../input/composerKeyBindings';
import { formatPolicyMode } from '../overlays/policyPickerModel';
import type {
  TuiConnectionStatus,
  TuiSessionState,
} from '../session/sessionController';
import { sessionActorLabel } from '../session/sessionDisplay';
import { truncateTerminalLine } from '../text/terminalText';
import { TUI_VERSION } from '../version';

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');

export function formatHeader(
  state: TuiSessionState,
  width = Number.POSITIVE_INFINITY,
  composerMode: AgentSession['kind'] = state.session.kind,
) {
  const model = state.session.runtime?.model?.trim();
  return fitStatusSegments([
    `PinPawo TUI v2 · v${TUI_VERSION}`,
    formatConnection(state.connection),
    ...(composerMode === 'studio' ? ['studio'] : []),
    ...(model ? [model] : []),
  ], width);
}

export function formatStatusLine(
  state: TuiSessionState,
  width = Number.POSITIVE_INFINITY,
) {
  if (state.connectionDetail && state.connection !== 'ready') {
    return truncateTerminalLine(state.connectionDetail, width);
  }
  const session = state.session;
  const usage = formatUsage(session);
  const path = session.runtime?.cwd
    ? compactPath(session.runtime.cwd)
    : null;
  const full = [
    ...(state.connectionDetail ? [state.connectionDetail] : []),
    usage,
    ...(path ? [path] : []),
  ];
  if (displayWidth(full) <= width) return full.join(' · ');
  const withoutPath = full.filter((segment) => segment !== path);
  if (displayWidth(withoutPath) <= width) return withoutPath.join(' · ');

  const compactUsage = formatCompactUsage(session);
  const compact = [
    ...(state.connectionDetail ? [state.connectionDetail] : []),
    compactUsage,
  ];
  if (displayWidth(compact) <= width) return compact.join(' · ');
  if (!state.connectionDetail) {
    const inputOutput = compactUsage.split(' · ')[0] ?? compactUsage;
    if (stringWidth(inputOutput) <= width) return inputOutput;
  }
  return truncateTerminalLine(compact.join(' · '), width);
}

export function formatStatusLines(
  state: TuiSessionState,
  width: number,
  notice?: string | null,
): readonly [string, string] {
  const primary = notice?.trim()
    || state.connectionDetail?.trim()
    || [
      formatConnection(state.connection),
      formatRunStatus(state.session),
      ...(state.session.runtime?.globalReviewPolicyMode
        ? [`policy: ${formatPolicyMode(state.session.runtime.globalReviewPolicyMode)}`]
        : []),
      ...(state.session.runtime?.model?.trim()
        ? [state.session.runtime.model.trim()]
        : []),
    ].join(' · ');
  return [
    truncateTerminalLine(primary, width),
    formatStatusLine({
      ...state,
      connectionDetail: undefined,
    }, width),
  ];
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

export function formatComposerPlaceholder(
  session: AgentSession,
  composerMode: AgentSession['kind'] = session.kind,
) {
  const actor = sessionActorLabel(session);
  const run = session.activeRun;
  if (run?.state === 'waiting_review') {
    return 'Review required · use the approval panel';
  }
  if (run?.state === 'interrupting') {
    return 'Stopping response…';
  }
  if (run?.activity === 'using_tool') {
    return `${actor} is using a tool · draft next message · Esc interrupt`;
  }
  if (run?.activity === 'streaming') {
    return `${actor} is responding · draft next message · Esc interrupt`;
  }
  if (run) {
    return `Waiting for ${actor} · draft next message · Esc interrupt`;
  }
  if (session.hasResumableDelegation) {
    return 'Suspended delegation available · /continue <guidance> or type a new request';
  }
  return composerMode === 'studio'
    ? STUDIO_COMPOSER_PLACEHOLDER
    : COMPOSER_PLACEHOLDER;
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

function formatCompactUsage(session: AgentSession) {
  const usage = session.sessionTokenUsage ?? session.tokenUsage;
  const contextWindow = usage?.contextWindow ?? session.runtime?.contextWindow;
  if (!usage) return 'in/out: –/–';
  const latestInput = usage.latestInputTokens;
  const remainingPercent = latestInput !== undefined && contextWindow
    ? Math.max(0, Math.round((1 - latestInput / contextWindow) * 100))
    : null;
  return [
    `in/out: ${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`,
    ...(remainingPercent !== null ? [`ctx: ${remainingPercent}% left`] : []),
  ].join(' · ');
}

function formatRunStatus(session: AgentSession) {
  const run = session.activeRun;
  if (!run) {
    return session.hasResumableDelegation
      ? 'delegation paused · /continue'
      : 'idle';
  }
  if (run.state === 'waiting_review') return 'review';
  if (run.state === 'interrupting') return 'interrupting';
  if (run.activity === 'using_tool') return 'tool';
  if (run.activity === 'streaming') return 'streaming';
  return 'thinking';
}

function fitStatusSegments(segments: string[], width: number) {
  const kept = [...segments];
  while (kept.length > 1 && displayWidth(kept) > width) {
    kept.pop();
  }
  return truncateTerminalLine(kept.join(' · '), width);
}

function displayWidth(segments: string[]) {
  return stringWidth(segments.join(' · '));
}
