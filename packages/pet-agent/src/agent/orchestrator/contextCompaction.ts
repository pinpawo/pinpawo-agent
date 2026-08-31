import { AIMessage, RemoveMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getAgentMessageLane,
  getAgentMessageMetadata,
  mainConversationMessages,
  queryAgentMessages,
  setAgentMessageMetadata,
  toolProtocolSafeMessages,
} from '../messages';
import { formatDelegationAnnounceForModel, getDelegationAnnounce } from './delegation';
import { clipForPrompt, readMessageText } from './utils';
import { xmlTextBlock } from './prompts/shared';
import { createInvocationContextMessage } from '../modelContext/invocationContext';
import { CONTEXT_COMPACTION_SYSTEM_PROMPT } from './prompts/templates/contextCompaction.prompt';

const DEFAULT_KEEP_MESSAGES = 10;
const DEFAULT_FALLBACK_SUMMARY_CHARS = 4000;
export const CONTEXT_COMPACTION_MESSAGE_NAME = 'context_compaction';

export type ContextCompactionOptions = {
  keepMessages?: number;
  preserveAnnouncesFor?: {
    lane: string;
    runId: string;
    delegationId: string;
  };
};

export type ContextCompactionResult = {
  messages: BaseMessage[];
  compacted: boolean;
  mainMessageCount: number;
};

export function isContextCompactionMessage(message: BaseMessage): boolean {
  return message.name === CONTEXT_COMPACTION_MESSAGE_NAME
    || getAgentMessageMetadata(message).source === CONTEXT_COMPACTION_MESSAGE_NAME;
}

export function createContextCompactionMessage(
  summary: string,
  mainMessageCount: number,
): AIMessage {
  const message = new AIMessage(xmlTextBlock(
    'context_summary',
    summary,
    ' role="context" source="compaction"',
  ));
  message.name = CONTEXT_COMPACTION_MESSAGE_NAME;
  setAgentMessageMetadata(message, {
    source: CONTEXT_COMPACTION_MESSAGE_NAME,
    synthetic: true,
    authority: 'none',
    compaction: 'summary',
    mainMessageCount,
  });
  return message;
}

function selectMessagesToKeep(
  messages: BaseMessage[],
  keepMessages: number,
  preserveAnnouncesFor: ContextCompactionOptions['preserveAnnouncesFor'],
): BaseMessage[] {
  const candidates = messages.filter((message) => !isContextCompactionMessage(message));
  const recentMessages = new Set(candidates.slice(-Math.max(1, keepMessages)));
  // An active delegation's lane Announces are canonical Boundary evidence
  // until Planner accepts them. They are excluded from summaries, so pin every
  // still-lane-tagged Announce even when it falls outside the recent suffix.
  const selected = candidates.filter((message) => {
    if (recentMessages.has(message)) return true;
    if (!preserveAnnouncesFor || !getDelegationAnnounce(message)) return false;
    const meta = getAgentMessageMetadata(message);
    return getAgentMessageLane(message) === preserveAnnouncesFor.lane
      && meta.runId === preserveAnnouncesFor.runId
      && meta.delegationId === preserveAnnouncesFor.delegationId;
  });
  return toolProtocolSafeMessages(selected);
}

function formatMainMessageForSummary(message: BaseMessage): string | null {
  const announce = getDelegationAnnounce(message);
  if (announce) return formatDelegationAnnounceForModel(announce);
  const text = readMessageText(message);
  if (!text) return null;
  if (isContextCompactionMessage(message)) {
    return [`### 已有压缩摘要`, text].join('\n');
  }
  const type = message._getType();
  if (type === 'human') {
    return [`### 主线用户输入`, text].join('\n');
  }
  if (type === 'ai') {
    return [`### 主线 agent 回复`, text].join('\n');
  }
  return null;
}

function buildSummaryItems(messages: BaseMessage[]): string[] {
  const mainMessages = queryAgentMessages(messages).main().select().messages;
  return mainMessages.flatMap((message) => {
    const item = formatMainMessageForSummary(message);
    return item ? [item] : [];
  });
}

function buildNoisyFallbackSummary(messages: BaseMessage[]): string {
  const mainMessageCount = queryAgentMessages(messages).main().select().messages.length;

  return [
    '[以下是更早上下文的自动压缩摘要]',
    mainMessageCount > 0
      ? `- main: ${mainMessageCount.toString()} 条旧消息已压缩，未发现需要保留的主线输入或任务结果。`
      : '- 没有可保留的旧主线消息。',
  ].join('\n');
}

function renderMessagesForSummary(messages: BaseMessage[]): string {
  // The compaction watermark is derived from the provider's measured input
  // usage, and the retained suffix is excluded before this point. Pass every
  // remaining main message to the summarizer: per-message sampling loses facts
  // before the model can decide what belongs in the durable summary.
  return buildSummaryItems(messages).join('\n\n');
}

function buildFallbackSummary(messages: BaseMessage[]): string {
  const heading = '[以下是更早上下文的自动压缩摘要]';
  const existingSummary = buildSummaryItems(
    messages.filter(isContextCompactionMessage),
  ).at(-1);
  const recentItems = buildSummaryItems(
    messages.filter((message) => !isContextCompactionMessage(message)),
  ).slice(existingSummary ? -7 : -8);
  const importantLines = recentItems
    .map((item) => `- ${clipForPrompt(item.replace(/\n+/g, ' '), 260)}`);
  const recentSummary = importantLines.length > 0
    ? importantLines.join('\n')
    : existingSummary
      ? null
      : buildNoisyFallbackSummary(messages).replace(`${heading}\n`, '');
  const reservedChars = heading.length
    + (recentSummary?.length ?? 0)
    + (existingSummary && recentSummary ? 2 : 1);
  const existingSummaryChars = Math.max(0, DEFAULT_FALLBACK_SUMMARY_CHARS - reservedChars);
  const boundedExistingSummary = existingSummary && existingSummaryChars > 1
    ? clipForPrompt(existingSummary, existingSummaryChars)
    : null;

  return [
    heading,
    boundedExistingSummary,
    recentSummary,
  ].filter((line): line is string => line !== null).join('\n');
}

async function summarizeMessages(params: {
  model: BaseChatModel;
  messages: BaseMessage[];
  runnableConfig?: RunnableConfig;
}): Promise<string> {
  const renderedMessages = renderMessagesForSummary(params.messages);
  if (!renderedMessages.trim()) {
    return buildFallbackSummary(params.messages);
  }

  const response = await params.model.invoke(
    [
      new SystemMessage(CONTEXT_COMPACTION_SYSTEM_PROMPT.render({})),
      createInvocationContextMessage({
        name: 'context_compaction_input',
        content: `请压缩以下旧上下文：\n\n${renderedMessages}`,
      }),
    ],
    params.runnableConfig,
  );

  return readMessageText(response) || buildFallbackSummary(params.messages);
}

export async function compactOrchestratorMessages(params: {
  messages: BaseMessage[];
  model: BaseChatModel;
  options?: ContextCompactionOptions;
  runnableConfig?: RunnableConfig;
}): Promise<ContextCompactionResult> {
  const { messages, model } = params;
  const triggerMessages = mainConversationMessages(messages);
  const mainMessageCount = triggerMessages.length;
  const keepMessages = params.options?.keepMessages ?? DEFAULT_KEEP_MESSAGES;

  const keptMessages = selectMessagesToKeep(
    messages,
    keepMessages,
    params.options?.preserveAnnouncesFor,
  );
  const keptMessageRefs = new Set(keptMessages);
  const keptIds = new Set(keptMessages.map((message) => message.id).filter((id): id is string => Boolean(id)));
  const messagesToSummarize = messages.filter((message) => {
    if (keptMessageRefs.has(message)) return false;
    return !message.id || !keptIds.has(message.id);
  });
  if (messagesToSummarize.length === 0) {
    return { messages: [], compacted: false, mainMessageCount };
  }

  let summary = '';
  try {
    summary = await summarizeMessages({
      model,
      messages: messagesToSummarize,
      runnableConfig: params.runnableConfig,
    });
  } catch (error) {
    console.warn('[pet-agent] context compaction summarization failed:', {
      error: error instanceof Error ? error.message : String(error),
    });
    summary = buildFallbackSummary(messagesToSummarize);
  }

  const summaryMessage = createContextCompactionMessage(summary, mainMessageCount);

  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      summaryMessage,
      ...keptMessages,
    ] as BaseMessage[],
    compacted: true,
    mainMessageCount,
  };
}
