import type { BaseMessage } from '@langchain/core/messages';
import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from './events/agentStreamNormalizer';
import type { LocalAgentOperationEvent } from './events/localAgentEvent';
import { localToolOperationRegistry } from './plugins/localTools';

export type { StreamToolsPayload };

export function buildToolOperationEvent(requestId: string, payload: StreamToolsPayload): LocalAgentOperationEvent {
  return normalizeToolStreamEvent(requestId, payload, localToolOperationRegistry);
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

export function readMessageChunkText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
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
      .join('');
  }
  return '';
}

export function readStreamNode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || !('langgraph_node' in metadata)) {
    return null;
  }
  const node = metadata.langgraph_node;
  return typeof node === 'string' ? node : null;
}

export function isLaneTaggedAiMessage(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return Boolean(pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo);
}
