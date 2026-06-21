import { HumanMessage, RemoveMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  getMessageIsAnnounce,
  getMessageDelegatedTask,
  getMessageDelegationId,
  getMessageLane,
  getMessageTurnId,
  mainConversationMessages,
  toolProtocolSafeMessages,
} from './messageLanes';
import { clipForPrompt, readMessageText } from './utils';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32000;
const DEFAULT_KEEP_MESSAGES = 10;
const CHARS_PER_TOKEN = 4;
export const CONTEXT_COMPACTION_MESSAGE_NAME = 'context_compaction';

export type ContextCompactionOptions = {
  contextWindowTokens?: number;
  keepMessages?: number;
};

export type ContextCompactionResult = {
  messages: BaseMessage[];
  compacted: boolean;
  estimatedTokens: number;
  triggerTokens: number;
};

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: BaseMessage): number {
  const text = readMessageText(message);
  const metadata = message.additional_kwargs && Object.keys(message.additional_kwargs).length > 0
    ? JSON.stringify(message.additional_kwargs)
    : '';
  return estimateTextTokens(`${message._getType()}\n${text}\n${metadata}`);
}

export function estimateMessagesTokens(messages: BaseMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

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

function buildTriggerTokens(contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS): number {
  return Math.max(6000, Math.floor(contextWindowTokens * 0.75));
}

function buildSummarizationBudget(contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS): number {
  return Math.max(2000, Math.floor(contextWindowTokens * 0.35));
}

function selectMessagesToKeep(messages: BaseMessage[], keepMessages: number): BaseMessage[] {
  return toolProtocolSafeMessages(messages.slice(-Math.max(1, keepMessages)));
}

function formatMainMessageForSummary(message: BaseMessage): string | null {
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

function formatLaneAnnounceForSummary(message: BaseMessage): string | null {
  const lane = getMessageLane(message);
  if (!lane || lane === 'orchestrator') return null;
  if (!getMessageIsAnnounce(message)) return null;
  const text = readMessageText(message);

  return [
    `### 任务执行记录 (${[
      `lane=${lane}`,
      getMessageTurnId(message) ? `turn=${getMessageTurnId(message)}` : null,
      getMessageDelegationId(message) ? `delegation=${getMessageDelegationId(message)}` : null,
    ].filter(Boolean).join(', ')})`,
    getMessageDelegatedTask(message) ? `任务：${clipForPrompt(getMessageDelegatedTask(message) ?? '', 420)}` : null,
    text ? `结果：${clipForPrompt(text, 1200)}` : '结果：[无文本内容]',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatMessageForSummary(message: BaseMessage): string | null {
  const lane = getMessageLane(message);
  if (!lane) return formatMainMessageForSummary(message);
  return formatLaneAnnounceForSummary(message);
}

function buildSummaryItems(messages: BaseMessage[]): string[] {
  return messages.flatMap((message) => {
    const item = formatMessageForSummary(message);
    return item ? [item] : [];
  });
}

function buildNoisyFallbackSummary(messages: BaseMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const lane = getMessageLane(message) ?? 'main';
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const countLines = [...counts.entries()]
    .map(([lane, count]) => `- ${lane}: ${count} 条旧消息已压缩，未发现需要保留的主线输入或任务结果。`);

  return [
    '[以下是更早上下文的自动压缩摘要]',
    ...countLines,
  ].join('\n');
}

function buildSummaryTranscript(messages: BaseMessage[], tokenBudget: number): string {
  const chunks = buildSummaryItems(messages);
  const selectedChunks: string[] = [];
  let usedTokens = 0;

  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    const chunkTokens = estimateTextTokens(chunk);
    if (selectedChunks.length > 0 && usedTokens + chunkTokens > tokenBudget) {
      break;
    }
    selectedChunks.unshift(chunk);
    usedTokens += chunkTokens;
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
  contextWindowTokens?: number;
  runnableConfig?: RunnableConfig;
}): Promise<string> {
  const transcript = buildSummaryTranscript(
    params.messages,
    buildSummarizationBudget(params.contextWindowTokens),
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
  const contextWindowTokens = params.options?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const keepMessages = params.options?.keepMessages ?? DEFAULT_KEEP_MESSAGES;
  const triggerTokens = buildTriggerTokens(contextWindowTokens);
  const triggerMessages = mainConversationMessages(messages);
  const estimatedTokens = estimateMessagesTokens(triggerMessages);

  if (triggerMessages.length <= keepMessages || estimatedTokens < triggerTokens) {
    return { messages: [], compacted: false, estimatedTokens, triggerTokens };
  }

  const keptMessages = selectMessagesToKeep(messages, keepMessages);
  const keptMessageRefs = new Set(keptMessages);
  const keptIds = new Set(keptMessages.map((message) => message.id).filter((id): id is string => Boolean(id)));
  const messagesToSummarize = messages.filter((message) => {
    if (keptMessageRefs.has(message)) return false;
    return !message.id || !keptIds.has(message.id);
  });
  if (messagesToSummarize.length === 0) {
    return { messages: [], compacted: false, estimatedTokens, triggerTokens };
  }

  let summary = '';
  try {
    summary = await summarizeMessages({
      model,
      messages: messagesToSummarize,
      contextWindowTokens,
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
      estimatedTokens,
      triggerTokens,
    },
  };

  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      summaryMessage,
      ...keptMessages,
    ] as BaseMessage[],
    compacted: true,
    estimatedTokens,
    triggerTokens,
  };
}
