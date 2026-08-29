import type { BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';

export type CapabilityMessageLane = `capability:${string}`;
export type AgentMessageLane = CapabilityMessageLane | 'orchestrator';

export type DelegationMessageScope = {
  lane: CapabilityMessageLane;
  transcriptRunId: string;
  delegationId: string;
};

export type AgentMessageMetadata = Record<string, unknown>;

export function getAgentMessageMetadata(message: BaseMessage): AgentMessageMetadata {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object'
    ? pinpawo as AgentMessageMetadata
    : {};
}

export function setAgentMessageMetadata(
  message: BaseMessage,
  patch: AgentMessageMetadata,
) {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    pinpawo: { ...getAgentMessageMetadata(message), ...patch },
  };
  return message;
}

export function ensureAgentMessageId(message: BaseMessage): string {
  message.id ??= randomUUID();
  return message.id;
}

export function getAgentMessageLane(message: BaseMessage): AgentMessageLane | null {
  const lane = getAgentMessageMetadata(message).lane;
  return typeof lane === 'string' ? lane as AgentMessageLane : null;
}

export function isCapabilityMessageLane(
  lane: AgentMessageLane | string | null,
): lane is CapabilityMessageLane {
  return Boolean(lane?.startsWith('capability:'));
}

export function getAgentMessageDelegationId(message: BaseMessage): string | null {
  const delegationId = getAgentMessageMetadata(message).delegationId;
  return typeof delegationId === 'string' && delegationId.trim()
    ? delegationId
    : null;
}

export function getAgentMessageTranscriptRunId(message: BaseMessage): string | null {
  const runId = getAgentMessageMetadata(message).runId;
  return typeof runId === 'string' && runId.trim() ? runId : null;
}

export function getAgentMessageDelegationScope(
  message: BaseMessage,
): DelegationMessageScope | null {
  const lane = getAgentMessageLane(message);
  if (!isCapabilityMessageLane(lane)) return null;
  const transcriptRunId = getAgentMessageTranscriptRunId(message);
  const delegationId = getAgentMessageDelegationId(message);
  return transcriptRunId && delegationId
    ? { lane, transcriptRunId, delegationId }
    : null;
}

export function setAgentMessageDelegationScope(
  message: BaseMessage,
  scope: DelegationMessageScope,
) {
  return setAgentMessageMetadata(message, {
    lane: scope.lane,
    runId: scope.transcriptRunId,
    delegationId: scope.delegationId,
  });
}

export function delegationMessageScopesEqual(
  left: DelegationMessageScope,
  right: DelegationMessageScope,
) {
  return left.lane === right.lane
    && left.transcriptRunId === right.transcriptRunId
    && left.delegationId === right.delegationId;
}

export function stampAgentMessageCreatedAt(
  message: BaseMessage,
  createdAt = new Date().toISOString(),
) {
  return setAgentMessageMetadata(message, { createdAt });
}

export function readAgentMessageCreatedAt(message: BaseMessage): string | null {
  const createdAt = getAgentMessageMetadata(message).createdAt;
  return typeof createdAt === 'string' && createdAt.trim() ? createdAt : null;
}

export function isInvocationOnlyAgentMessage(message: BaseMessage): boolean {
  const metadata = getAgentMessageMetadata(message);
  return metadata.persistence === 'invocation'
    || (
      metadata.source === 'delegation_briefing'
      && metadata.handoffFrom === undefined
    );
}

// Stable names retained at the public package boundary after implementation
// ownership moved into the Agent message package.
export const setPinpetMeta = setAgentMessageMetadata;
export const getMessageLane = getAgentMessageLane;
export const getMessageDelegationId = getAgentMessageDelegationId;
export const getMessageTranscriptRunId = getAgentMessageTranscriptRunId;
export const stampMessageCreatedAtUtc = stampAgentMessageCreatedAt;
export const readMessageCreatedAtUtc = readAgentMessageCreatedAt;
