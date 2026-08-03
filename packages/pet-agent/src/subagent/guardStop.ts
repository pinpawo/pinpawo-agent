import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export const SUBAGENT_GUARD_STOP_MARKER_KEY = 'subagentGuardStop' as const;

export type SubagentGuardStopReason = 'subagent_iteration_limit_reached';

const SUBAGENT_GUARD_STOP_REASONS: readonly SubagentGuardStopReason[] = [
  'subagent_iteration_limit_reached',
];

export function buildSubagentGuardStopNotice(
  reason: SubagentGuardStopReason,
  text: string,
): AIMessage {
  return new AIMessage({
    content: text,
    additional_kwargs: {
      pinpawo: { [SUBAGENT_GUARD_STOP_MARKER_KEY]: reason },
    },
  });
}

/**
 * Effect helper for the `subagent_iteration_limit` guard's stop outcome: the
 * marked notice the middleware position appends before ending the run.
 */
export function buildSubagentIterationLimitStopNotice(
  attemptedIteration: number,
  maxIterations: number,
): AIMessage {
  return buildSubagentGuardStopNotice('subagent_iteration_limit_reached', [
    `Subagent loop reached its iteration limit: attempted ${attemptedIteration}, limit ${maxIterations}.`,
    'Stop the loop and report the current progress instead of waiting for LangGraph recursionLimit.',
  ].join('\n'));
}

function isSubagentGuardStopReason(value: unknown): value is SubagentGuardStopReason {
  return typeof value === 'string'
    && (SUBAGENT_GUARD_STOP_REASONS as readonly string[]).includes(value);
}

export function readSubagentGuardStopReason(message: BaseMessage): SubagentGuardStopReason | null {
  const pinpawo = (message as { additional_kwargs?: { pinpawo?: unknown } }).additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') {
    return null;
  }
  const value = (pinpawo as Record<string, unknown>)[SUBAGENT_GUARD_STOP_MARKER_KEY];
  return isSubagentGuardStopReason(value) ? value : null;
}

export function isSubagentGuardStopMessage(message: BaseMessage): boolean {
  return readSubagentGuardStopReason(message) !== null;
}
