import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from './events/agentStreamNormalizer';
import type { AgentOperationEvent } from '@pinpawo/agent-session';
import {
  emptyOperationRegistry,
  type OperationRegistry,
} from './events/operationRegistry';

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
