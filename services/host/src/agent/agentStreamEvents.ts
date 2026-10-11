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

export function readFinalMessageText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

/** The tool calls a message makes, exactly as the model wrote them. */
export function readMessageToolCalls(message: BaseMessage): Array<Omit<AgentMessageToolCall, 'status'>> {
  if (!AIMessage.isInstance(message)) return [];
  return (message.tool_calls ?? []).flatMap(call => call.id ? [{ id: call.id, name: call.name, args: call.args ?? {} }] : []);
}

/** Main-conversation tool results keyed by the call they answer; lane results are private work. */
export function readToolResultStatuses(messages: readonly unknown[]) {
  return new Map(messages.flatMap(message => ToolMessage.isInstance(message) && isMainConversationMessage(message)
    ? [[message.tool_call_id, message.status === 'error' ? 'failed' as const : 'completed' as const]]
    : []));
}

/** A public main-conversation message that this run wrote. */
export function isPublicRunMessage(message: BaseMessage, runId: unknown) {
  const messageRunId = getAgentMessageRunId(message);
  return isPublicConversationMessage(message) && messageRunId !== null && messageRunId === runId;
}
