import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from '../events/agentStreamNormalizer';
import type { AgentMessageToolCall, AgentOperationEvent } from '@pinpawo/agent-session';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageRunId,
  isMainConversationMessage,
  isPublicConversationMessage,
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

/** Main-conversation tool results keyed by the call they answer; lane results are private work. */
export function readToolResults(messages: readonly unknown[]) {
  return new Map(messages.flatMap(message => ToolMessage.isInstance(message) && isMainConversationMessage(message)
    ? [[message.tool_call_id, readToolResult(message)]]
    : []));
}

/** A call's outcome; a failure keeps what the tool returned, which says why. */
function readToolResult(message: ToolMessage): { status: 'completed' | 'failed'; error?: string } {
  return message.status === 'error'
    ? { status: 'failed', error: readMessageText(message) }
    : { status: 'completed' };
}

/** A public main-conversation message that this run wrote. */
export function isPublicRunMessage(message: BaseMessage, runId: unknown) {
  const messageRunId = getAgentMessageRunId(message);
  return isPublicConversationMessage(message) && messageRunId !== null && messageRunId === runId;
}
