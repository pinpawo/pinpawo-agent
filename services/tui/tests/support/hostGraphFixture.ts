import assert from 'node:assert/strict';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import type {
  AgentChannelSetup,
} from '../../../local-agent/src/agentChannel';
import type {
  InterruptResume,
  LocalAgentGraphService,
} from '../../../local-agent/src/agentGraphService';

export const ASSISTANT_MESSAGE = '# Result\n\nThe **host transport** is aligned.';
export const INTERRUPT_MESSAGE = 'Start a long host task.';
export const INTERRUPT_PARTIAL = 'Partial host output.';
export const REVIEW_APPROVE_MESSAGE = 'Request an approved host action.';
export const REVIEW_CANCEL_MESSAGE = 'Request a cancelled host action.';
export const REVIEW_APPROVED_REPLY = 'Approved host action.';
export const REVIEW_REJECTED_REPLY = 'Rejected host action.';
export const REVIEW_CONTINUE_GUIDANCE =
  'Continue the suspended host action with the new constraints.';
export const ERROR_MESSAGE = 'Trigger a deterministic host failure.';
export const ERROR_PARTIAL = 'Partial output before failure.';
export const GRAPH_ERROR = 'deterministic graph failure';

export const REVIEW_SPEC = {
  id: 'tool-review:host_fixture:call-1',
  schemaVersion: 1,
  view: {
    kind: 'plain',
    title: 'Host fixture action',
    body: 'Allow the deterministic host fixture to continue?',
  },
  options: [{
    id: 'approve',
    label: 'Approve',
    decision: { type: 'approve' },
  }, {
    id: 'reject',
    label: 'Reject',
    variant: 'danger',
    decision: { type: 'reject', message: 'Cancelled by user.' },
  }],
} satisfies ReviewSpec;

export function createHostGraphFixture() {
  const messagesByThread = new Map<string, BaseMessage[]>();
  const pendingInterrupts = new Map<string, {
    interruptId: string;
    review: ReviewSpec;
  }>();
  const suspendedReviews = new Map<string, {
    interruptId: string;
    review: ReviewSpec;
  }>();
  const reviewResumes: unknown[] = [];
  let inputMessages: BaseMessage[] = [];
  let observedInterrupt = false;
  let streams = 0;
  const service = {
    async readThreadState(setup: AgentChannelSetup) {
      const threadKey = readThreadKey(setup);
      const pendingInterrupt = pendingInterrupts.get(threadKey) ?? null;
      const pauseTaskInterrupt = suspendedReviews.has(threadKey)
        ? { kind: 'pause_task' as const }
        : null;
      return {
        messages: messagesByThread.get(threadKey) ?? [],
        pendingInterrupt: pendingInterrupt
          ? {
              interruptId: pendingInterrupt.interruptId,
              payload: {
                kind: 'human_review' as const,
                reviews: [pendingInterrupt.review],
              },
            }
          : null,
        acceptsResume:
          pendingInterrupt !== null || suspendedReviews.has(readThreadKey(setup)),
      };
    },
    streamEvents(setup: AgentChannelSetup, resume?: InterruptResume) {
      streams += 1;
      const threadKey = readThreadKey(setup);
      if (resume) {
        const pendingInterrupt = pendingInterrupts.get(threadKey);
        assert.ok(pendingInterrupt, 'expected a pending review before graph resume');
        assert.equal(
          resume.interruptId,
          pendingInterrupt.interruptId,
          'a resume must name the interrupt it answers',
        );
        reviewResumes.push({ [resume.interruptId]: resume.value });
        pendingInterrupts.delete(threadKey);
        if (isInterruptRunResume(resume.value)) {
          suspendedReviews.set(threadKey, pendingInterrupt);
          return checkpointStream(
            messagesByThread.get(threadKey) ?? [],
          );
        }
        const selectedOptionId = readSelectedOptionId(resume.value);
        const reply = selectedOptionId === 'approve'
          ? REVIEW_APPROVED_REPLY
          : REVIEW_REJECTED_REPLY;
        const finalReply = new AIMessage({
          content: reply,
          usage_metadata: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
          },
        });
        finalReply.id = `assistant-review-${selectedOptionId}`;
        const messages = [
          ...(messagesByThread.get(threadKey) ?? []),
          finalReply,
        ];
        messagesByThread.set(threadKey, messages);
        return assistantReplyStream(finalReply.id, reply, messages);
      }

      inputMessages = [...setup.input.messages];
      const inputText = inputMessages.at(-1)?.content;
      const accumulatedInput = [
        ...(messagesByThread.get(threadKey) ?? []),
        ...inputMessages,
      ];
      // A suspended review is re-raised by resuming its interrupt, not by a
      // transition flag on the next chat request.
      suspendedReviews.delete(threadKey);
      if (
        typeof inputText === 'string'
        && (
          inputText.includes(REVIEW_APPROVE_MESSAGE)
          || inputText.includes(REVIEW_CANCEL_MESSAGE)
        )
      ) {
        const interruptId = inputText.includes(REVIEW_APPROVE_MESSAGE)
          ? 'review-interrupt-approve'
          : 'review-interrupt-cancel';
        messagesByThread.set(threadKey, accumulatedInput);
        pendingInterrupts.set(threadKey, {
          interruptId,
          review: REVIEW_SPEC,
        });
        return reviewInterruptStream({
          interruptId,
          review: REVIEW_SPEC,
        });
      }
      if (typeof inputText === 'string' && inputText.includes(ERROR_MESSAGE)) {
        messagesByThread.set(threadKey, accumulatedInput);
        return (async function* () {
          yield protocolEvent('messages', {
            event: 'message-start',
            id: 'assistant-error',
          });
          yield protocolEvent('messages', {
            event: 'content-block-delta',
            delta: {
              type: 'text-delta',
              text: ERROR_PARTIAL,
            },
          });
          throw new Error(GRAPH_ERROR);
        })();
      }
      if (typeof inputText === 'string' && inputText.includes(INTERRUPT_MESSAGE)) {
        messagesByThread.set(threadKey, accumulatedInput);
        return (async function* () {
          yield protocolEvent('messages', {
            event: 'message-start',
            id: 'assistant-interrupt',
          });
          yield protocolEvent('messages', {
            event: 'content-block-delta',
            delta: {
              type: 'text-delta',
              text: INTERRUPT_PARTIAL,
            },
          });
          await waitForAbort(setup.input.signal);
          observedInterrupt = true;
          yield protocolEvent('values', { messages: inputMessages });
        })();
      }

      const finalReply = new AIMessage({
        content: ASSISTANT_MESSAGE,
        usage_metadata: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
        },
      });
      finalReply.id = 'assistant-final';
      const messages = [...accumulatedInput, finalReply];
      messagesByThread.set(threadKey, messages);
      return (async function* () {
        const toolNamespace = ['general:host', 'tools:read'];
        yield protocolEvent('tools', {
          event: 'tool-started',
          tool_call_id: 'operation-1',
          tool_name: 'read_fixture',
          input: { path: 'services/tui' },
        }, toolNamespace);

        const subagentNamespace = ['general:host', 'model_request:explore'];
        yield protocolEvent('messages', {
          event: 'message-start',
          id: 'subagent-1',
        }, subagentNamespace);
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: {
            type: 'text-delta',
            text: 'Found transport evidence.',
          },
        }, subagentNamespace);
        yield protocolEvent('messages', {
          event: 'message-finish',
        }, subagentNamespace);

        yield protocolEvent('tools', {
          event: 'tool-finished',
          tool_call_id: 'operation-1',
          output: 'host output',
        }, toolNamespace);

        yield protocolEvent('messages', {
          event: 'message-start',
          id: 'assistant-final',
        });
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: {
            type: 'text-delta',
            text: ASSISTANT_MESSAGE,
          },
        });
        yield protocolEvent('messages', {
          event: 'message-finish',
        });
        yield protocolEvent('values', { messages });
      })();
    },
  } as unknown as LocalAgentGraphService;

  return {
    service,
    inputMessages: () => inputMessages,
    interruptObserved: () => observedInterrupt,
    reviewResumes: () => reviewResumes,
    streamCount: () => streams,
  };
}

function reviewInterruptStream(pending: {
  interruptId: string;
  review: ReviewSpec;
}) {
  return (async function* () {
    yield protocolEvent('values', {
      __interrupt__: [{
        id: pending.interruptId,
        value: {
          kind: 'review',
          review: pending.review,
        },
      }],
    });
  })();
}

function checkpointStream(messages: BaseMessage[]) {
  return (async function* () {
    yield protocolEvent('values', { messages });
  })();
}

function assistantReplyStream(
  messageId: string,
  text: string,
  messages: BaseMessage[],
) {
  return (async function* () {
    yield protocolEvent('messages', {
      event: 'message-start',
      id: messageId,
    });
    yield protocolEvent('messages', {
      event: 'content-block-delta',
      delta: {
        type: 'text-delta',
        text,
      },
    });
    yield protocolEvent('messages', {
      event: 'message-finish',
    });
    yield protocolEvent('values', { messages });
  })();
}

function readSelectedOptionId(resolution: unknown) {
  assert.ok(resolution && typeof resolution === 'object');
  const decisions = (resolution as { decisions?: unknown }).decisions;
  assert.ok(Array.isArray(decisions));
  const selectedOptionId = (
    decisions[0] as { selectedOptionId?: unknown } | undefined
  )?.selectedOptionId;
  assert.ok(
    selectedOptionId === 'approve' || selectedOptionId === 'reject',
    'expected a canonical review decision',
  );
  return selectedOptionId;
}

function isInterruptRunResume(resolution: unknown) {
  return Boolean(
    resolution
    && typeof resolution === 'object'
    && !Array.isArray(resolution)
    && (resolution as { action?: unknown }).action === 'interrupt_run',
  );
}

function readThreadKey(setup: AgentChannelSetup) {
  assert.ok(setup.input.threadId, 'Host fixture requires a thread ID');
  return setup.input.threadId;
}

async function waitForAbort(signal: AbortSignal | undefined) {
  assert.ok(signal, 'expected production chat handler to attach an abort signal');
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function protocolEvent(
  method: string,
  data: unknown,
  namespace: string[] = [],
) {
  return {
    type: 'event' as const,
    seq: 0,
    method,
    params: {
      namespace,
      data,
    },
  };
}
