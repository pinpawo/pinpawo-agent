import { HumanMessage, RemoveMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getMessageLane,
  mainConversationMessages,
  toolProtocolSafeMessages,
} from './messageLanes';
import { clipForPrompt, readMessageText } from './utils';
import { isDelegationBriefingMessage } from './delegationBriefing';

const DEFAULT_KEEP_MESSAGES = 10;
const DEFAULT_SUMMARY_TRANSCRIPT_CHARS = 12000;
export const CONTEXT_COMPACTION_MESSAGE_NAME = 'context_compaction';

export type ContextCompactionOptions = {
  keepMessages?: number;
  summaryTranscriptChars?: number;
};

export type ContextCompactionResult = {
  messages: BaseMessage[];
  compacted: boolean;
  mainMessageCount: number;
};

export function isContextCompactionMessage(message: BaseMessage): boolean {
  return message._getType() === 'system' && message.name === CONTEXT_COMPACTION_MESSAGE_NAME;
}

export function readContextCompactionSummaries(messages: BaseMessage[], limit = 2): string[] {
  const summaries: string[] = [];
  for (let i = messages.length - 1; i >= 0 && summaries.length < limit; i--) {
    const message = messages[i];
    if (!isContextCompactionMessage(message)) continue;
    const text = readMessageText(message);
    if (text) {
      summaries.unshift(text);
    }
  }
  return summaries;
}

function selectMessagesToKeep(messages: BaseMessage[], keepMessages: number): BaseMessage[] {
  return toolProtocolSafeMessages(messages.slice(-Math.max(1, keepMessages)));
}

function formatMainMessageForSummary(message: BaseMessage): string | null {
  if (isDelegationBriefingMessage(message)) return null;
  const type = message._getType();
  const text = readMessageText(message);
  if (!text) return null;
  if (type === 'human') {
    return [`### 主线用户输入`, clipForPrompt(text, 1200)].join('\n');
  }
  if (type === 'ai') {
    return [`### 主线 agent 回复`, clipForPrompt(text, 1200)].join('\n');
  }
  if (isContextCompactionMessage(message)) {
    return [`### 已有压缩摘要`, clipForPrompt(text, 1600)].join('\n');
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

function buildSummaryTranscript(messages: BaseMessage[], maxChars: number): string {
  const chunks = buildSummaryItems(messages);
  const selectedChunks: string[] = [];
  let usedChars = 0;

  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (selectedChunks.length > 0 && usedChars + chunk.length > maxChars) {
      break;
    }
    selectedChunks.unshift(chunk);
    usedChars += chunk.length;
  }

  return selectedChunks.join('\n\n');
}

function buildFallbackSummary(messages: BaseMessage[]): string {
  const importantLines = buildSummaryItems(messages)
    .slice(-8)
    .map((item) => `- ${clipForPrompt(item.replace(/\n+/g, ' '), 260)}`);

  return [
    '[以下是更早上下文的自动压缩摘要]',
    importantLines.length > 0
      ? importantLines.join('\n')
      : buildNoisyFallbackSummary(messages).replace('[以下是更早上下文的自动压缩摘要]\n', ''),
  ].join('\n');
}

async function summarizeMessages(params: {
  model: BaseChatModel;
  messages: BaseMessage[];
  summaryTranscriptChars?: number;
  runnableConfig?: RunnableConfig;
}): Promise<string> {
  const transcript = buildSummaryTranscript(
    params.messages,
    params.summaryTranscriptChars ?? DEFAULT_SUMMARY_TRANSCRIPT_CHARS,
  );
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

  const keptMessages = selectMessagesToKeep(messages, keepMessages);
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
      summaryTranscriptChars: params.options?.summaryTranscriptChars,
      runnableConfig: params.runnableConfig,
    });
  } catch (error) {
    console.warn('[pet-agent] context compaction summarization failed:', {
      error: error instanceof Error ? error.message : String(error),
    });
    summary = buildFallbackSummary(messagesToSummarize);
  }

  const summaryMessage = new SystemMessage(summary);
  summaryMessage.name = CONTEXT_COMPACTION_MESSAGE_NAME;
  summaryMessage.additional_kwargs = {
    pinpawo: {
      compaction: 'summary',
      mainMessageCount,
    },
  };

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
