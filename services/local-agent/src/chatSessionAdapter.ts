import type { BaseMessage } from '@langchain/core/messages';
import type { AgentChannelSetup } from './agentChannel';
import type { LocalAgentGraphService } from './agentGraphService';
import {
  formatInterruptPrompt,
  normalizeInterruptResume,
  readPendingInterrupt,
  type ChatRequestMessage,
  type LocalAgentServerMessage,
} from './chatInterface';
import {
  INTERNAL_AI_STREAM_NODES,
  isLaneTaggedAiMessage,
  readFinalMessageText,
  readMessageChunkText,
  readStreamNode,
  type StreamToolsPayload,
} from './agentStreamEvents';
import { clearAgentRunActivity, recordAgentRunActivity } from './toolActivityState';

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
  emit: (message: LocalAgentServerMessage) => void;
  emitToolLog: (payload: StreamToolsPayload) => void;
  onPendingInterrupt?: (interruptPayload: Record<string, unknown>) => void | Promise<void>;
};

export async function runChatSession(options: ChatSessionAdapterOptions): Promise<ChatSessionResult> {
  const { request, setup, graphService, isCurrent, finishInterrupted, emit, emitToolLog } = options;
  const { requestId, message } = request;

  const threadSnapshot = await graphService.getState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const pendingInterrupt = readPendingInterrupt(threadSnapshot);
  if (pendingInterrupt) {
    await options.onPendingInterrupt?.(pendingInterrupt);
    if (!isCurrent()) {
      finishInterrupted();
      return { status: 'interrupted' };
    }
  }

  const resumeValue = pendingInterrupt
    ? normalizeInterruptResume(pendingInterrupt, message, request.resume)
    : undefined;
  const graphInput = pendingInterrupt
    ? graphService.buildResumeCommand(resumeValue)
    : undefined;

  setup.input.onToolEvent = (event) => {
    if (isCurrent()) {
      emitToolLog(event);
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
        if (streamNode && INTERNAL_AI_STREAM_NODES.has(streamNode)) {
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
        emit({
          type: 'chat_token',
          requestId,
          token,
        });
        continue;
      }

      if (mode === 'tools' && payload && typeof payload === 'object' && 'event' in payload && 'name' in payload) {
        emitToolLog(payload as StreamToolsPayload);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && 'messages' in payload) {
        finalMessages = ((payload as { messages?: BaseMessage[] }).messages ?? []);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && '__interrupt__' in payload) {
        const interruptPayload = readFirstInterruptPayload(payload);
        if (interruptPayload) {
          recordAgentRunActivity('waiting_human', requestId);
          emit({
            type: 'human_interrupt',
            requestId,
            prompt: formatInterruptPrompt(interruptPayload),
            payload: interruptPayload,
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
    recordAgentRunActivity('waiting_human', requestId);
    emit({
      type: 'human_interrupt',
      requestId,
      prompt: formatInterruptPrompt(finalInterrupt),
      payload: finalInterrupt,
    });
    return { status: 'waiting_human' };
  }

  const finalReply = finalMessages.length > 0
    ? readFinalMessageText(finalMessages.at(-1) ?? {})
    : '';
  emit({
    type: 'chat_response',
    requestId,
    message: finalReply,
    mood: null,
    topic: null,
    tags: [],
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
