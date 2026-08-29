import { AIMessage, HumanMessage, RemoveMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getMessageIsAnnounce,
} from './delegationMessages';
import {
  getMessageLane,
  getAgentMessageMetadata,
  mainConversationMessages,
  setPinpetMeta,
  toolProtocolSafeMessages,
} from '../messages';
import { formatDelegationAnnounceForModel, getDelegationAnnounce } from './delegationAnnounce';
import { clipForPrompt, readMessageText } from './utils';
import { isDelegationBriefingMessage } from './delegationBriefing';
import { xmlTextBlock } from './prompts/shared';

const DEFAULT_KEEP_MESSAGES = 10;
const DEFAULT_FALLBACK_SUMMARY_CHARS = 4000;
export const CONTEXT_COMPACTION_MESSAGE_NAME = 'context_compaction';

export type ContextCompactionOptions = {
  keepMessages?: number;
  preserveAnnouncesFor?: {
    lane: string;
    transcriptRunId: string;
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
  setPinpetMeta(message, {
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
    if (!preserveAnnouncesFor || !getMessageIsAnnounce(message)) return false;
    const meta = getAgentMessageMetadata(message);
    return getMessageLane(message) === preserveAnnouncesFor.lane
      && meta.runId === preserveAnnouncesFor.transcriptRunId
      && meta.delegationId === preserveAnnouncesFor.delegationId;
  });
  return toolProtocolSafeMessages(selected);
}

function formatMainMessageForSummary(message: BaseMessage): string | null {
  if (isDelegationBriefingMessage(message)) return null;
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

function formatMessageForSummary(message: BaseMessage): string | null {
  if (getMessageLane(message)) return null;
  return formatMainMessageForSummary(message);
}

function buildSummaryItems(messages: BaseMessage[]): string[] {
  return messages.flatMap((message) => {
    const item = formatMessageForSummary(message);
    return item ? [item] : [];
  });
}

function buildNoisyFallbackSummary(messages: BaseMessage[]): string {
  const mainMessageCount = messages.filter((message) => !getMessageLane(message)).length;

  return [
    '[以下是更早上下文的自动压缩摘要]',
    mainMessageCount > 0
      ? `- main: ${mainMessageCount.toString()} 条旧消息已压缩，未发现需要保留的主线输入或任务结果。`
      : '- 没有可保留的旧主线消息。',
  ].join('\n');
}

function buildSummaryTranscript(messages: BaseMessage[]): string {
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
  const transcript = buildSummaryTranscript(params.messages);
  if (!transcript.trim()) {
    return buildFallbackSummary(params.messages);
  }

  const response = await params.model.invoke(
    [
      new SystemMessage([
        '你在为一个长运行的任务执行通用 agent 压缩旧上下文。',
        '目标是让后续 agent 能延续当前任务，而不是把摘要写成新的用户指令。',
        '最重要：保留任务目标、执行计划、已执行步骤、完成结果、交付物、当前进度、阻塞点和下一步。',
        '同时保留：用户约束、关键决策、工具/能力调用结论、外部副作用、权限确认、风险或失败原因。',
        '丢弃：寒暄、重复内容、无关日志、已被后续结果覆盖的中间过程。',
        '用中文，结构化要点，尽量简洁；优先写清任务状态和结果。',
      ].join('\n')),
      new HumanMessage(`请压缩以下旧上下文：\n\n${transcript}`),
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
