import { formatSessionUsageMetrics } from '@pinpawo/agent-session';
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
import { truncateTerminalLine } from '../text/terminalText';
import { tuiText } from '../i18n/text';

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
    formatSessionUsageMetrics(session),
    usage,
    ...(path ? [path] : []),
  ];
  if (displayWidth(full) <= width) return full.join(' · ');
  const withoutPath = full.filter((segment) => segment !== path);
  if (displayWidth(withoutPath) <= width) return withoutPath.join(' · ');

  const compact = [
    ...(state.connectionDetail ? [state.connectionDetail] : []),
    formatSessionUsageMetrics(session),
    ...usage.split(' · ').slice(1),
  ];
  if (displayWidth(compact) <= width) return compact.join(' · ');
  const metricsOnly = [
    ...(state.connectionDetail ? [state.connectionDetail] : []),
    formatSessionUsageMetrics(session),
  ];
  if (displayWidth(metricsOnly) <= width) return metricsOnly.join(' · ');
  if (!state.connectionDetail) {
    const total = formatSessionUsageMetrics(session).split(' · ').at(-1)!;
    if (stringWidth(total) <= width) return total;
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
      ...(state.session.runtime?.toolAuthorizationMode
        ? [
            `policy: ${formatPolicyMode(
              state.session.runtime.toolAuthorizationMode,
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
) {
  const run = session.activeRun;
  if (session.pendingInterrupt?.payload.kind === 'human_review') {
    return 'Review required · use the approval panel';
  }
  if (run?.state === 'interrupting') {
    return 'Stopping response…';
  }
  if (run) {
    return `${tuiText().runningPlaceholder} · ${tuiText().detailsHint}`;
  }
  return `${COMPOSER_PLACEHOLDER} · ${tuiText().detailsHint}`;
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

function displayWidth(segments: string[]) {
  return stringWidth(segments.join(' · '));
}
