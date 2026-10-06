import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  mainConversationMessages,
  readCapabilityExecutions,
  readAgentMessageCreatedAt,
  readLatestProviderInputTokens,
  readMainToolCallMessages,
  readMessagesTokenUsage,
  type TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import type { AgentInputModality, AgentMessageToolCall, AgentResultReference } from '@pinpawo/agent-session';
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
  resultReferences?: AgentResultReference[];
  /** Tools Root called in this main message; `running` means no result is checkpointed yet. */
  toolCalls?: AgentMessageToolCall[];
  text: string;
  createdAt?: string;
};

type TuiCheckpointMessageSource = { role: 'user' | 'assistant' };
/** Aggregate provider usage for one session's transcript. */
export type TuiCheckpointTokenUsage = (TokenUsageSnapshot & { scope: 'session' }) | null;

export function readTuiCheckpointMessages(messages: BaseMessage[]): TuiCheckpointMessage[] {
  // Tool results remain execution evidence; never replay deliveries as chat messages.
  const toolCallsByMessage = new Map(readMainToolCallMessages(messages)
    .map(({ messageId, toolCalls }) => [messageId, toolCalls]));
  return messages.flatMap<TuiCheckpointMessage>((message) => {
    const source = readTuiCheckpointMessageSource(message);
    if (!source) return [];
    const text = readLocalChatDisplayText(message) ?? readFinalMessageText(message);
    const toolCalls = source.role === 'assistant' && message.id ? toolCallsByMessage.get(message.id) : undefined;
    if (!text && !toolCalls) {
      return [];
    }
    const createdAt = readAgentMessageCreatedAt(message);
    const resultReferences = source.role === 'assistant' && AIMessage.isInstance(message) && !message.tool_calls?.length
      ? readReplyResultReferences(messages, message) : [];
    return [{
      ...source,
      text,
      ...(resultReferences.length ? { resultReferences } : {}),
      ...(toolCalls ? { toolCalls } : {}),
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

/** Associate only preceding, validated deliveries from the reply's own run. */
export function readReplyResultReferences(messages: BaseMessage[], reply: BaseMessage | undefined): AgentResultReference[] {
  if (!reply) return [];
  const metadata = reply.additional_kwargs?.pinpawo;
  const runId = metadata && typeof metadata === 'object' && 'runId' in metadata ? metadata.runId : null;
  if (!runId) return [];
  const index = messages.indexOf(reply);
  if (index < 0) return [];
  return readCapabilityExecutions(messages.slice(0, index)).flatMap(({ metadata, result }) =>
    metadata.runId === runId && result?.status === 'returned' && result.delivery
      ? [{ id: result.delivery.id, title: result.delivery.task, text: result.delivery.text }] : []);
}
