import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getMessageIsAnnounce,
  getMessageLane,
  getPinpetMeta,
  laneMessages,
  mainConversationMessages,
  toolProtocolSafeMessages,
} from '../messageLanes';
import type { MessageLane } from '../types';
import {
  formatDelegationAnnounceForModel,
  isDelegationAnnounceMessage,
  projectDelegationAnnouncesForModel,
} from '../delegationAnnounce';
import { readMessageText } from '../utils';
import type { CapabilityPlannerInput } from './runner';

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

function selectCurrentMainConversation(messages: readonly BaseMessage[]) {
  const mainMessages = mainConversationMessages([...messages]);
  let currentRequestIndex = -1;
  for (let index = mainMessages.length - 1; index >= 0; index -= 1) {
    if (mainMessages[index]?._getType() === 'human') {
      currentRequestIndex = index;
      break;
    }
  }
  return currentRequestIndex >= 0
    ? mainMessages.slice(0, currentRequestIndex + 1)
    : mainMessages;
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
  announceMessageId: string | null;
}): BaseMessage[] {
  const plannerMessages = params.messages.filter((message) =>
    isCapabilityPlannerMessage(message, params.traceId, params.registryDigest),
  );
  const currentMainMessages = selectCurrentMainConversation(params.messages);
  if (params.mode === 'entry') {
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
  const currentAnnounce = params.announceMessageId
    ? currentContext.find((message) => message.id === params.announceMessageId)
    : [...currentContext].reverse().find(getMessageIsAnnounce);
  return toolProtocolSafeMessages([
    ...plannerMessages,
    ...currentMainMessages,
    ...(currentAnnounce ? [currentAnnounce] : []),
  ]);
}

/**
 * Project canonical messages only at the Planner model boundary.
 *
 * Accepted handoffs are already typed DelegationAnnounceMessages. The current
 * delegation's announce is still a private lane message because accepting it is
 * precisely the decision this Boundary invocation must make. Project that one
 * message from the root-owned Boundary identity without persisting a premature
 * handoff copy.
 */
export function projectCapabilityPlannerMessagesForModel(
  messages: readonly BaseMessage[],
  input: CapabilityPlannerInput,
): BaseMessage[] {
  const projectedMessages = projectDelegationAnnouncesForModel(messages);
  if (input.mode !== 'boundary') {
    return projectedMessages;
  }
  const currentAnnounce = input.latestAnnounce;
  if (!currentAnnounce?.messageId) {
    return projectedMessages;
  }
  const { messageId, completionReason } = currentAnnounce;

  return projectedMessages.map((projectedMessage, index) => {
    const canonicalMessage = messages[index];
    if (!canonicalMessage
      || canonicalMessage.id !== messageId
      || isDelegationAnnounceMessage(canonicalMessage)) {
      return projectedMessage;
    }
    return new AIMessage({
      id: canonicalMessage.id,
      content: formatDelegationAnnounceForModel({
        sourceLane: `capability:${input.activeDelegation.capability}`,
        task: input.activeDelegation.task,
        completionReason,
        result: readMessageText(canonicalMessage),
      }),
      additional_kwargs: {
        ...canonicalMessage.additional_kwargs,
        pinpawo: {
          ...getPinpetMeta(canonicalMessage),
          source: 'delegation_announce_projection',
          synthetic: true,
          authority: 'none',
        },
      },
    });
  });
}
