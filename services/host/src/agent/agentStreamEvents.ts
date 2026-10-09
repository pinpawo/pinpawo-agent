import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from '../events/agentStreamNormalizer';
import type { AgentMessageToolCall, AgentOperationEvent } from '@pinpawo/agent-session';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
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
  return new Map(messages.flatMap(message => ToolMessage.isInstance(message) && isConversationMessage(message)
    ? [[message.tool_call_id, message.status === 'error' ? 'failed' as const : 'completed' as const]]
    : []));
}

/**
 * Root's conversation: its unlaned messages and the Supervisor's own work
 * (planning, review, delegation), which is the main agent at work. Other
 * lanes, such as a Capability's transcript, and synthetic bookkeeping are not.
 */
export function isConversationMessage(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return true;
  const { lane, synthetic } = pinpawo as Record<string, unknown>;
  return synthetic !== true && (lane === undefined || lane === 'supervisor');
}
