import type { BaseMessage } from '@langchain/core/messages';
import { isOrchestratorInternalAiStreamNode } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type { LocalAgentGraphService } from './agentGraphService';
import {
  buildReviewSpecFromInterruptPayload,
  formatInterruptPrompt,
  normalizeInterruptResume,
  readPendingInterrupt,
} from './chatInterrupts';
import type {
  ChatRequestMessage,
} from './localAgentProtocol';
import type { LocalAgentEvent } from './events/localAgentEvent';
import {
  isLaneTaggedAiMessage,
  readFinalMessageText,
  readMessageChunkText,
  readStreamNode,
  type StreamToolsPayload,
} from './agentStreamEvents';
import { clearAgentRunActivity, recordAgentRunActivity } from './operationActivityState';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32000;
const CHARS_PER_TOKEN = 4;

function readMessages(snapshot: unknown): BaseMessage[] {
  const values = (snapshot as { values?: { messages?: unknown } } | null)?.values;
  const messages = values?.messages;
  return Array.isArray(messages) ? messages as BaseMessage[] : [];
}

function hasPendingGraphContinuation(snapshot: unknown) {
  const record = snapshot && typeof snapshot === 'object'
    ? snapshot as { next?: unknown; tasks?: unknown }
    : null;
  const next = Array.isArray(record?.next) ? record.next : [];
  if (next.length > 0) {
    return true;
  }
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  return tasks.length > 0;
}

function estimateTextTokens(text: string) {
  return Math.max(0, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function estimateMessageTokens(message: BaseMessage) {
  const content = readFinalMessageText(message);
  const metadata = message.additional_kwargs && Object.keys(message.additional_kwargs).length > 0
    ? JSON.stringify(message.additional_kwargs)
    : '';
  return estimateTextTokens(`${message._getType()}\n${content}\n${metadata}`);
}

function estimateMessagesTokens(messages: BaseMessage[]) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export type ChatSessionResult =
  | { status: 'completed'; reply: string }
  | { status: 'waiting_human' }
  | { status: 'interrupted' };

export type ChatSessionAdapterOptions = {
  request: Pick<ChatRequestMessage, 'requestId' | 'message' | 'resume'>;
  setup: AgentChannelSetup;
  graphService: LocalAgentGraphService;
  isCurrent: () => boolean;
  finishInterrupted: () => void;
  emitEvent: (event: LocalAgentEvent) => void;
  emitToolEvent: (payload: StreamToolsPayload) => void;
};

function throwUnexpectedInterruptPayload(): never {
  throw new Error('Received an interrupt without canonical human review payload.');
}

export async function runChatSession(options: ChatSessionAdapterOptions): Promise<ChatSessionResult> {
  const { request, setup, graphService, isCurrent, finishInterrupted, emitEvent, emitToolEvent } = options;
  const { requestId, message } = request;

  const threadSnapshot = await graphService.getState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const pendingInterrupt = readPendingInterrupt(threadSnapshot);
  const hasExplicitResume = request.resume !== undefined;
  const shouldResume = Boolean(
    pendingInterrupt
    || (hasExplicitResume && hasPendingGraphContinuation(threadSnapshot)),
  );
  const resumeValue = pendingInterrupt
    ? normalizeInterruptResume(pendingInterrupt, message, request.resume)
    : hasExplicitResume
      ? request.resume
      : undefined;
  const graphInput = shouldResume
    ? graphService.buildResumeCommand(resumeValue)
    : undefined;

  setup.input.onToolEvent = (event) => {
    if (isCurrent()) {
      emitToolEvent(event);
    }
  };

  let finalMessages: BaseMessage[] = [];
  let streamedReply = '';
  try {
    for await (const chunk of graphService.stream(setup, graphInput)) {
      if (!isCurrent()) {
        finishInterrupted();
        return { status: 'interrupted' };
      }

      if (!Array.isArray(chunk)) {
        continue;
      }

      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'messages' && Array.isArray(payload)) {
        const [streamMessage, metadata] = payload as [BaseMessage, Record<string, unknown> | undefined];
        if (streamMessage._getType() !== 'ai') {
          continue;
        }
        const streamNode = readStreamNode(metadata);
        if (streamNode && isOrchestratorInternalAiStreamNode(streamNode)) {
          continue;
        }
        if (isLaneTaggedAiMessage(streamMessage)) {
          continue;
        }
        const chunkText = readMessageChunkText(streamMessage);
        if (!chunkText) {
          continue;
        }
        const token = chunkText.startsWith(streamedReply)
          ? chunkText.slice(streamedReply.length)
          : chunkText;
        if (!token) {
          continue;
        }
        streamedReply += token;
        recordAgentRunActivity('streaming', requestId);
        emitEvent({
          type: 'message.delta',
          requestId,
          role: 'assistant',
          text: token,
        });
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && 'messages' in payload) {
        finalMessages = ((payload as { messages?: BaseMessage[] }).messages ?? []);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && '__interrupt__' in payload) {
        const interruptPayload = readFirstInterruptPayload(payload);
        if (interruptPayload) {
          const review = buildReviewSpecFromInterruptPayload(interruptPayload);
          if (!review) {
            throwUnexpectedInterruptPayload();
          }
          recordAgentRunActivity('waiting_human', requestId);
          emitEvent({
            type: 'human_review.requested',
            requestId,
            prompt: formatInterruptPrompt(interruptPayload),
            payload: interruptPayload,
            review,
          });
          return { status: 'waiting_human' };
        }
      }
    }
  } finally {
    setup.input.onToolEvent = undefined;
  }

  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const finalSnapshot = await graphService.getState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const finalInterrupt = readPendingInterrupt(finalSnapshot);
  if (finalInterrupt) {
    const review = buildReviewSpecFromInterruptPayload(finalInterrupt);
    if (!review) {
      throwUnexpectedInterruptPayload();
    }
    recordAgentRunActivity('waiting_human', requestId);
    emitEvent({
      type: 'human_review.requested',
      requestId,
      prompt: formatInterruptPrompt(finalInterrupt),
      payload: finalInterrupt,
      review,
    });
    return { status: 'waiting_human' };
  }

  const finalReply = finalMessages.length > 0
    ? readFinalMessageText(finalMessages.at(-1) ?? {})
    : '';
  const finalTokens = estimateMessagesTokens(readMessages(finalSnapshot));
  const inputTokens = estimateMessagesTokens([
    ...readMessages(threadSnapshot),
    ...setup.input.messages,
  ]);
  const outputTokens = Math.max(0, finalTokens - inputTokens);
  const contextWindow = setup.graphConfig.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const finalUsage = {
    inputTokens,
    outputTokens,
    totalTokens: finalTokens,
    contextWindow,
    updatedAt: new Date().toISOString(),
  };
  emitEvent({
    type: 'message.completed',
    requestId,
    role: 'assistant',
    text: finalReply,
    usage: finalUsage,
    metadata: {
      mood: null,
      topic: null,
      tags: [],
    },
  });
  clearAgentRunActivity(requestId);

  return { status: 'completed', reply: finalReply };
}

function readFirstInterruptPayload(payload: object): Record<string, unknown> | null {
  const rawInterrupts = (payload as { __interrupt__?: unknown }).__interrupt__;
  const firstInterrupt = Array.isArray(rawInterrupts) ? rawInterrupts[0] : null;
  return firstInterrupt
    && typeof firstInterrupt === 'object'
    && 'value' in firstInterrupt
    && firstInterrupt.value
    && typeof firstInterrupt.value === 'object'
    ? firstInterrupt.value as Record<string, unknown>
    : null;
}
