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
