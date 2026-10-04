import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, setAgentMessageMetadata, type AgentMessageMetadata } from '../../messages';

export type ReviewStopDecision = 'reject' | 'cancel';

/** A completed review outcome, never a resumable interrupt or graph state. */
export function buildReviewStopMessage(decision: ReviewStopDecision, metadata: AgentMessageMetadata = {}) {
  const message = new AIMessage({
    content: decision === 'reject'
      ? '你拒绝了本次操作，操作未执行，本轮已结束。计划已保留；发送新的明确指示后再继续。'
      : '你取消了本次审批，操作未执行，本轮已结束。计划已保留；发送新的明确指示后再继续。',
  });
  setAgentMessageMetadata(message, { ...metadata, runtimeGenerated: true, reviewDecision: decision });
  return message;
}

export function readReviewStopDecision(message: BaseMessage | undefined): ReviewStopDecision | null {
  if (!message || !AIMessage.isInstance(message)) return null;
  const metadata = getAgentMessageMetadata(message);
  return metadata.runtimeGenerated === true
    && (metadata.reviewDecision === 'reject' || metadata.reviewDecision === 'cancel')
    ? metadata.reviewDecision : null;
}
