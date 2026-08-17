import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getMessageLane,
  getPinpetMeta,
  laneMessages,
  mainConversationMessages,
  toolProtocolSafeMessages,
} from '../messageLanes';
import type { MessageLane } from '../types';

export const CAPABILITY_PLANNER_MESSAGE_SOURCE = 'capability_planner';

export function isCapabilityPlannerMessage(
  message: BaseMessage,
  traceId?: string,
  registryDigest?: string,
) {
  const meta = getPinpetMeta(message);
  return getMessageLane(message) === 'orchestrator'
    && meta.source === CAPABILITY_PLANNER_MESSAGE_SOURCE
    && (!traceId || meta.traceId === traceId)
    && (!registryDigest || meta.registryDigest === registryDigest);
}

export function removeStaleCapabilityPlannerMessages(
  messages: readonly BaseMessage[],
  traceId: string,
) {
  return messages.flatMap((message) => {
    if (!isCapabilityPlannerMessage(message)) return [];
    if (getPinpetMeta(message).traceId === traceId) return [];
    return message.id ? [new RemoveMessage({ id: message.id }) as BaseMessage] : [];
  });
}

export function selectCapabilityPlannerMessages(params: {
  mode: 'entry';
  messages: readonly BaseMessage[];
  traceId: string;
  registryDigest: string;
} | {
  mode: 'boundary';
  messages: readonly BaseMessage[];
  traceId: string;
  registryDigest: string;
  lane: MessageLane;
  transcriptRunId: string;
  delegationId: string;
}): BaseMessage[] {
  const plannerMessages = params.messages.filter((message) =>
    isCapabilityPlannerMessage(message, params.traceId, params.registryDigest),
  );
  if (params.mode === 'entry') {
    const mainMessages = mainConversationMessages([...params.messages]);
    let currentRequestIndex = -1;
    for (let index = mainMessages.length - 1; index >= 0; index -= 1) {
      if (mainMessages[index]?._getType() === 'human') {
        currentRequestIndex = index;
        break;
      }
    }
    const currentMainMessages = currentRequestIndex >= 0
      ? mainMessages.slice(0, currentRequestIndex + 1)
      : mainMessages;
    return toolProtocolSafeMessages([
      ...plannerMessages,
      ...currentMainMessages,
    ]);
  }
  const currentContext = laneMessages(
    [...params.messages],
    params.lane,
    params.transcriptRunId,
    params.delegationId,
  );
  return toolProtocolSafeMessages([
    ...plannerMessages,
    ...currentContext,
  ]);
}
