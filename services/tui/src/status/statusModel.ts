import type { AgentSession } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import {
  COMPOSER_PLACEHOLDER,
} from '../input/composerKeyBindings';
import { formatPolicyMode } from '../overlays/policyPickerModel';
import type {
  TuiConnectionStatus,
  TuiSessionState,
} from '../session/sessionController';
import { sessionActorLabel } from '../session/sessionDisplay';
import { truncateTerminalLine } from '../text/terminalText';

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');

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
  const runtimeModel = formatRuntimeModel(state.session);
  const primary = notice?.trim()
    || state.connectionDetail?.trim()
    || [
      formatConnection(state.connection),
      ...(state.session.runtime?.globalReviewPolicyMode
        ? [
            `policy: ${formatPolicyMode(
              state.session.runtime.globalReviewPolicyMode,
              state.session.runtime.autoAuthorizationSafetyLevel ?? 'strict',
            )}`,
          ]
        : []),
      ...(runtimeModel ? [runtimeModel] : []),
    ].join(' · ');
  return [
    truncateTerminalLine(primary, width),
    formatStatusLine({
      ...state,
      connectionDetail: undefined,
    }, width),
  ];
}

export function formatRuntimeModel(session: AgentSession) {
  const profileLabel = session.runtime?.modelProfileLabel?.trim();
  const providerModel = session.runtime?.model?.trim();
  if (profileLabel && providerModel && profileLabel !== providerModel) {
    return `${profileLabel} (${providerModel})`;
  }
  return profileLabel || providerModel;
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
  options: {
    pausedTask?: boolean;
  } = {},
) {
  const actor = sessionActorLabel(session);
  const run = session.activeRun;
  if (session.pendingInterrupt?.payload.kind === 'human_review') {
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
  if (options.pausedTask) {
    return 'Task paused · Enter to continue · Esc starts a new task';
  }
  return COMPOSER_PLACEHOLDER;
}

export function formatUsage(session: AgentSession) {
  const usage = session.sessionTokenUsage ?? session.tokenUsage;
  const contextWindow = usage?.contextWindow ?? session.runtime?.contextWindow;
  const contextCompactionWatermarkTokens = session.runtime?.contextCompactionWatermarkTokens;
  if (!usage) {
    return contextWindow
      ? `in/out: –/– · context: ${formatCount(contextWindow)}`
      : 'in/out: –/–';
  }
  const latestInput = usage.latestInputTokens;
  const compactRemainingPercent = remainingPercent(
    latestInput,
    contextCompactionWatermarkTokens,
  );
  const contextRemainingPercent = remainingPercent(latestInput, contextWindow);
  return [
    `in/out: ${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`,
    ...(compactRemainingPercent !== null
      ? [`compact: ${compactRemainingPercent}% left`]
      : contextRemainingPercent !== null
        ? [`ctx: ${contextRemainingPercent}% left`]
        : []),
  ].join(' · ');
}

/**
 * Headroom before a budget is reached, as a percentage. Absolute token counts
 * read as "used" next to the cumulative in/out totals, so both status variants
 * report the remaining share instead.
 */
function remainingPercent(
  latestInput: number | undefined,
  budget: number | undefined,
) {
  if (latestInput === undefined || !budget) return null;
  return Math.max(0, Math.round((1 - latestInput / budget) * 100));
}

function compactPath(path: string) {
  const pieces = path.split(/[\\/]/).filter(Boolean);
  if (pieces.length <= 2) return path;
  return `…/${pieces.slice(-2).join('/')}`;
}

function formatCount(value: number) {
  return COUNT_FORMATTER.format(Math.max(0, Math.round(value)));
}

/**
 * Narrow-width usage. Both variants now report the same remaining percentage;
 * only the no-usage case differs, where the wide line can still afford to name
 * the context window.
 */
function formatCompactUsage(session: AgentSession) {
  const usage = session.sessionTokenUsage ?? session.tokenUsage;
  if (!usage) return 'in/out: –/–';
  return formatUsage(session);
}

function displayWidth(segments: string[]) {
  return stringWidth(segments.join(' · '));
}
