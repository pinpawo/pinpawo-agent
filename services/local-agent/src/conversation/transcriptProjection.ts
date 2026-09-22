import type { BaseMessage } from '@langchain/core/messages';
import {
  mainConversationMessages,
  readAgentMessageCreatedAt,
  readLatestProviderInputTokens,
  readMessagesTokenUsage,
  type TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import type { AgentInputModality } from '@pinpawo/agent-session';
import { readLocalChatDisplayText } from './chatDisplayText';
import { readFinalMessageText } from '../agent/agentStreamEvents';

/**
 * Transcript projection for the interface.
 *
 * Everything here takes checkpoint messages and nothing else: these functions
 * hold no session state and decide nothing about execution. They turn a
 * transcript into what a screen shows — which is why they belong to
 * Conversation rather than to the session registry they used to live in.
 */

export type TuiCheckpointMessage = {
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
};

type TuiCheckpointMessageSource = { role: 'user' | 'assistant' };
/** Aggregate provider usage for one session's transcript. */
export type TuiCheckpointTokenUsage = (TokenUsageSnapshot & { scope: 'session' }) | null;

export function readTuiCheckpointMessages(messages: BaseMessage[]): TuiCheckpointMessage[] {
  // Tool results remain execution evidence; never replay deliveries as chat messages.
  return messages.flatMap<TuiCheckpointMessage>((message) => {
    const source = readTuiCheckpointMessageSource(message);
    if (!source) return [];
    const text = readLocalChatDisplayText(message) ?? readFinalMessageText(message);
    if (!text) {
      return [];
    }
    const createdAt = readAgentMessageCreatedAt(message);
    return [{
      ...source,
      text,
      ...(createdAt ? { createdAt } : {}),
    }];
  });
}

/**
 * Input modalities the transcript actually contains. Derived from checkpoint
 * messages rather than recorded as tools run: the image blocks are the fact,
 * so nothing has to report back up to the host to keep a separate ledger in
 * sync — and a session repaired or rolled back stays consistent for free.
 */
export function readTuiCheckpointInputModalities(
  messages: BaseMessage[],
): AgentInputModality[] {
  const hasImage = messages.some((message) => (
    message.contentBlocks.some((block) => block.type === 'image')
  ));
  return hasImage ? ['text', 'image'] : ['text'];
}

export function readTuiCheckpointTokenUsage(
  messages: BaseMessage[],
): TuiCheckpointTokenUsage {
  const usage = readMessagesTokenUsage(messages);
  const latestInputTokens = readLatestProviderInputTokens(mainConversationMessages(messages));
  return usage
    ? {
        ...usage,
        ...(latestInputTokens !== null
          ? { latestInputTokens }
          : {}),
        source: 'provider',
        scope: 'session',
      }
    : null;
}

function readTuiCheckpointMessageSource(
  message: BaseMessage,
): TuiCheckpointMessageSource | null {
  const type = message._getType();
  if (type !== 'human' && type !== 'ai') return null;
  const pinpawo = message.additional_kwargs?.pinpawo;
  // Lane-tagged messages are internal Capability transcripts, never root
  // conversation. Filter them before the human/ai split.
  if (pinpawo && typeof pinpawo === 'object') {
    if ('lane' in pinpawo || (pinpawo as Record<string, unknown>).synthetic === true) {
      return null;
    }
  }
  if (type === 'human') return { role: 'user' };
  return { role: 'assistant' };
}

export function summarizeTuiCheckpointMessages(
  messages: TuiCheckpointMessage[],
  updatedAt = new Date().toISOString(),
) {
  const titleSource = messages.find((message) => message.role === 'user' && message.text.trim())
    ?? messages.find((message) => message.text.trim());
  const title = titleSource
    ? titleSource.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    : '空会话';
  return {
    title,
    messageCount: messages.length,
    updatedAt,
  };
}
