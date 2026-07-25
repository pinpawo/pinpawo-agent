import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../types/subagent';

const TOOL_REVIEW_CANCELLATION_SOURCE = 'tool_review_cancellation';

function readPinpawoMeta(message: BaseMessage): Record<string, unknown> {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object'
    ? pinpawo as Record<string, unknown>
    : {};
}

export function markToolReviewCancellationMessage<T extends BaseMessage>(message: T): T {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    pinpawo: {
      ...readPinpawoMeta(message),
      source: TOOL_REVIEW_CANCELLATION_SOURCE,
      synthetic: true,
      completionReason: 'cancelled' satisfies SubagentCompletionReason,
    },
  };
  return message;
}

export function isToolReviewCancellationMessage(message: BaseMessage): boolean {
  const meta = readPinpawoMeta(message);
  return meta.source === TOOL_REVIEW_CANCELLATION_SOURCE
    && meta.synthetic === true
    && meta.completionReason === 'cancelled';
}
