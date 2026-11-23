import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from '../events/agentStreamNormalizer';
import type { AgentMessageToolCall, AgentOperationEvent } from '@pinpawo/agent-session';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageRunId,
  isEntryRoutingMessage,
  isMainConversationMessage,
  isPublicConversationMessage,
  isSyntheticAgentMessage,
  readMessageText,
} from '@pinpawo/pet-agent';
import {
  emptyOperationRegistry,
  type OperationRegistry,
} from '../events/operationRegistry';

export type { StreamToolsPayload };

export function buildToolOperationEvent(
  requestId: string,
  payload: StreamToolsPayload,
  registry: OperationRegistry = emptyOperationRegistry,
): AgentOperationEvent {
  return normalizeToolStreamEvent(requestId, payload, registry);
}

/** The tool calls a message makes, exactly as the model wrote them. */
export function readMessageToolCalls(message: BaseMessage): Array<Omit<AgentMessageToolCall, 'status'>> {
  if (!AIMessage.isInstance(message)) return [];
  return (message.tool_calls ?? []).flatMap(call => call.id ? [{ id: call.id, name: call.name, args: call.args ?? {} }] : []);
}

function isVisibleEntryRoutingMessage(message: BaseMessage): boolean {
  return isEntryRoutingMessage(message) && !isSyntheticAgentMessage(message);
}

/** The UI shows Entry's goal and handoff alongside ordinary public conversation. */
export function isDisplayConversationMessage(message: BaseMessage): boolean {
  return isPublicConversationMessage(message) || isVisibleEntryRoutingMessage(message);
}

/** Displayed tool results keyed by their call, including Entry's handoff receipt. */
export function readToolResults(messages: readonly unknown[]) {
  return new Map(messages.flatMap(message => ToolMessage.isInstance(message)
    && (isMainConversationMessage(message) || isVisibleEntryRoutingMessage(message))
    ? [[message.tool_call_id, readToolResult(message)]]
    : []));
}

/** A call's outcome; a failure keeps what the tool returned, which says why. */
function readToolResult(message: ToolMessage): { status: 'completed' | 'failed'; error?: string } {
  return message.status === 'error'
    ? { status: 'failed', error: readMessageText(message) }
    : { status: 'completed' };
}

/** A displayed conversation message that this run wrote. */
export function isPublicRunMessage(message: BaseMessage, runId: unknown) {
  const messageRunId = getAgentMessageRunId(message);
  return isDisplayConversationMessage(message) && messageRunId !== null && messageRunId === runId;
}
