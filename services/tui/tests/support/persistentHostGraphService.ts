import { resolve } from 'node:path';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  Command,
  END,
  interrupt,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import {
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  readPauseTaskInterrupt,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type {
  AgentChannelSetup,
} from '../../../local-agent/src/agentChannel';
import type {
  LocalAgentGraphEventStream,
  LocalAgentGraphService,
  LocalAgentGraphThreadState,
} from '../../../local-agent/src/agentGraphService';

export const PERSISTENT_HOST_INPUT = 'Persist this host conversation.';
export const PERSISTENT_HOST_CONTINUATION = 'Continue after the host restart.';
export const PERSISTENT_HOST_REPLY = 'Persisted host reply.';
export const PERSISTENT_HOST_CONTINUATION_REPLY = 'Continued host reply.';
export const PERSISTENT_HOST_RESIZE_INPUT =
  'Keep the response active while the terminal resizes.';
export const PERSISTENT_HOST_RESIZE_REPLY =
  'Resize-safe host reply.';
export const PERSISTENT_HOST_ATTACHMENT_INPUT =
  'Persist the selected host attachments.';
export const PERSISTENT_HOST_ATTACHMENT_NAMES = [
  'first file.txt',
  '第二资料.md',
] as const;
export const PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME = 'remove me.tmp';
export const PERSISTENT_HOST_ATTACHMENT_REPLY =
  'Persisted selected host attachments.';
export const PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY =
  'Host attachment selection did not match.';
export const PERSISTENT_HOST_MENTION_NAME = '指南 文档.md';
export const PERSISTENT_HOST_MENTION_INPUT =
  `Inspect @${PERSISTENT_HOST_MENTION_NAME} carefully.`;
export const PERSISTENT_HOST_MENTION_REPLY =
  'Persisted completed workspace mention.';
export const PERSISTENT_HOST_EDITOR_INITIAL = 'original editor draft';
export const PERSISTENT_HOST_EDITOR_INPUT =
  'Edited by VISUAL.\n第二行。';
export const PERSISTENT_HOST_EDITOR_REPLY =
  'Persisted external editor draft.';
export const PERSISTENT_HOST_TIMELINE_INPUT =
  'Render the ordered production timeline.';
export const PERSISTENT_HOST_TIMELINE_REPLY =
  '# Ordered result\n\nThe **production timeline** is aligned.';
export const PERSISTENT_HOST_TIMELINE_TOOL_UPDATE =
  'ordered output pending';
export const PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT =
  'ordered host output';
export const PERSISTENT_HOST_TIMELINE_SUBAGENT =
  'Subagent progress stays distinct.';
export const PERSISTENT_HOST_REVIEW_INPUT =
  'Request the checkpointed production approval.';
export const PERSISTENT_HOST_REVIEW_APPROVED_REPLY =
  'Checkpointed production approval completed.';
export const PERSISTENT_HOST_REVIEW_REJECTED_REPLY =
  'Checkpointed production approval rejected.';
export const PERSISTENT_HOST_REVIEW_SPEC = {
  id: 'persistent-production-review',
  schemaVersion: 1,
  view: {
    kind: 'plain',
    title: 'Approve protected fixture',
    body: 'Allow the production host to complete this checkpointed action?',
  },
  options: [{
    id: 'approve',
    label: 'Approve',
    variant: 'primary',
    decision: { type: 'approve' },
  }, {
    id: 'reject',
    label: 'Reject',
    variant: 'danger',
    decision: {
      type: 'reject',
      message: 'Rejected by the production PTY fixture.',
    },
  }],
} satisfies ReviewSpec;

export function createPersistentHostGraphService() {
  const graphs = new Map<string, ReturnType<typeof createGraph>>();

  const graphFor = (setup: AgentChannelSetup) => {
    const cached = graphs.get(setup.graphKey);
    if (cached) return cached;
    const graph = createGraph(setup);
    graphs.set(setup.graphKey, graph);
    return graph;
  };

  return {
    async streamEvents(
      setup: AgentChannelSetup,
      inputOverride?: unknown,
    ) {
      const stream = await graphFor(setup).streamEvents(
        inputOverride ?? { messages: setup.input.messages },
        {
          version: 'v3',
          signal: setup.input.signal,
          configurable: configurable(setup),
        },
      );
      const input = String(setup.input.messages.at(-1)?.content ?? '');
      return input === PERSISTENT_HOST_TIMELINE_INPUT
        ? withTimelineFixtureEvents(
            stream as unknown as LocalAgentGraphEventStream,
          )
        : stream;
    },
    async readThreadState(
      setup: AgentChannelSetup,
    ): Promise<LocalAgentGraphThreadState> {
      const snapshot = await graphFor(setup).getState({
        configurable: configurable(setup),
      });
      const values = snapshot.values as {
        messages?: unknown;
      };
      return {
        messages: Array.isArray(values.messages)
          ? values.messages as BaseMessage[]
          : [],
        pendingInterrupt: readPendingReview(snapshot),
        pauseTaskInterrupt: readPauseTaskInterrupt(snapshot),
        hasPendingContinuation: hasPendingContinuation(snapshot),
        currentPlan: null,
      };
    },
    buildResumeCommand(resume: unknown) {
      return new Command({ resume });
    },
  } as unknown as LocalAgentGraphService;
}

function createGraph(setup: AgentChannelSetup) {
  if (!setup.graphConfig.checkpoint) {
    throw new Error('persistent host fixture requires a production checkpointer');
  }
  return new StateGraph(MessagesAnnotation)
    .addNode('answer', async (state) => {
      const input = String(state.messages.at(-1)?.content ?? '');
      if (input === PERSISTENT_HOST_RESIZE_INPUT) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      } else if (input === PERSISTENT_HOST_INPUT) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
      }
      const continuation = input.includes(PERSISTENT_HOST_CONTINUATION);
      const content = input === PERSISTENT_HOST_REVIEW_INPUT
        ? reviewReply(interrupt({
            kind: 'review',
            review: PERSISTENT_HOST_REVIEW_SPEC,
            pendingAction: {
              actionId: 'persistent-production-action',
              toolName: 'write_fixture',
              args: { path: 'protected-fixture.txt' },
              description: 'Write the protected production fixture',
            },
          }))
        : selectReply(input, setup.input.workdir);
      return {
        messages: [new AIMessage({
          content,
          usage_metadata: {
            input_tokens: continuation ? 6 : 4,
            output_tokens: 3,
            total_tokens: continuation ? 9 : 7,
          },
        })],
      };
    })
    .addEdge(START, 'answer')
    .addEdge('answer', END)
    .compile({
      checkpointer: setup.graphConfig.checkpoint,
    });
}

function selectReply(input: string, workdir?: string) {
  if (input.includes(PERSISTENT_HOST_CONTINUATION)) {
    return PERSISTENT_HOST_CONTINUATION_REPLY;
  }
  if (input.includes(PERSISTENT_HOST_ATTACHMENT_INPUT)) {
    const validSelection = input.includes('<local_attachments>')
      && typeof workdir === 'string'
      && PERSISTENT_HOST_ATTACHMENT_NAMES.every(
        (name) => input.includes(resolve(workdir, name)),
      )
      && !input.includes(PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME);
    return validSelection
      ? PERSISTENT_HOST_ATTACHMENT_REPLY
      : PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY;
  }
  if (input === PERSISTENT_HOST_MENTION_INPUT) {
    return PERSISTENT_HOST_MENTION_REPLY;
  }
  if (input === PERSISTENT_HOST_EDITOR_INPUT) {
    return PERSISTENT_HOST_EDITOR_REPLY;
  }
  if (input === PERSISTENT_HOST_RESIZE_INPUT) {
    return PERSISTENT_HOST_RESIZE_REPLY;
  }
  if (input === PERSISTENT_HOST_TIMELINE_INPUT) {
    return PERSISTENT_HOST_TIMELINE_REPLY;
  }
  return PERSISTENT_HOST_REPLY;
}

function withTimelineFixtureEvents(stream: LocalAgentGraphEventStream) {
  const wrapped = (async function* () {
    const toolNamespace = ['general:persistent', 'tools:read'];
    yield protocolEvent('tools', {
      event: 'tool-started',
      tool_call_id: 'persistent-operation-1',
      tool_name: 'read_fixture',
      input: { path: 'services/tui' },
    }, toolNamespace);
    await timelineFixturePause();

    const subagentNamespace = [
      'general:persistent',
      'model_request:timeline',
    ];
    yield protocolEvent('messages', {
      event: 'message-start',
      id: 'persistent-subagent-1',
    }, subagentNamespace);
    yield protocolEvent('messages', {
      event: 'content-block-delta',
      delta: {
        type: 'text-delta',
        text: PERSISTENT_HOST_TIMELINE_SUBAGENT,
      },
    }, subagentNamespace);
    yield protocolEvent('messages', {
      event: 'message-finish',
    }, subagentNamespace);
    await timelineFixturePause();

    yield protocolEvent('tools', {
      event: 'tool-output-delta',
      tool_call_id: 'persistent-operation-1',
      delta: PERSISTENT_HOST_TIMELINE_TOOL_UPDATE,
    }, toolNamespace);
    await timelineFixturePause();
    yield protocolEvent('tools', {
      event: 'tool-finished',
      tool_call_id: 'persistent-operation-1',
      output: PERSISTENT_HOST_TIMELINE_TOOL_OUTPUT,
    }, toolNamespace);

    yield protocolEvent('messages', {
      event: 'message-start',
      id: 'persistent-assistant-1',
    });
    for (const text of [
      '# Ordered result\n\n',
      'The **production timeline** ',
      'is aligned.',
    ]) {
      yield protocolEvent('messages', {
        event: 'content-block-delta',
        delta: {
          type: 'text-delta',
          text,
        },
      });
      await timelineFixturePause();
    }
    yield protocolEvent('messages', {
      event: 'message-finish',
    });

    for await (const event of stream) {
      yield event;
    }
  })() as unknown as LocalAgentGraphEventStream;
  Object.defineProperty(wrapped, 'output', {
    configurable: true,
    value: stream.output,
  });
  return wrapped;
}

function reviewReply(resume: unknown) {
  const decisions = readReviewDecisions(resume);
  const approved = decisions.length === 1
    && decisions[0]?.reviewId === PERSISTENT_HOST_REVIEW_SPEC.id
    && decisions[0]?.selectedOptionId === 'approve';
  return approved
    ? PERSISTENT_HOST_REVIEW_APPROVED_REPLY
    : PERSISTENT_HOST_REVIEW_REJECTED_REPLY;
}

function readReviewDecisions(value: unknown): ReviewResponse[] {
  const record = readRecord(value);
  const direct = record?.decisions;
  if (Array.isArray(direct)) {
    return direct as ReviewResponse[];
  }
  for (const candidate of Object.values(record ?? {})) {
    const decisions = readRecord(candidate)?.decisions;
    if (Array.isArray(decisions)) {
      return decisions as ReviewResponse[];
    }
  }
  return [];
}

function readPendingReview(
  snapshot: unknown,
): LocalAgentGraphThreadState['pendingInterrupt'] {
  const pending = readPendingInterrupt(snapshot);
  if (!pending?.id) return null;
  if (isHumanReviewBatchInterruptPayload(pending.value)) {
    const reviews = pending.value.reviews.map((item) => item.review);
    return reviews.length
      ? { interruptId: pending.id, reviews }
      : null;
  }
  return isHumanReviewInterruptPayload(pending.value)
    ? {
        interruptId: pending.id,
        reviews: [pending.value.review],
      }
    : null;
}

function readPendingInterrupt(snapshot: unknown) {
  const tasks = readRecord(snapshot)?.tasks;
  if (!Array.isArray(tasks)) return null;
  for (const task of tasks) {
    const interrupts = readRecord(task)?.interrupts;
    if (!Array.isArray(interrupts)) continue;
    const first = readRecord(interrupts[0]);
    if (!first || !first.value || typeof first.value !== 'object') continue;
    return {
      ...(typeof first.id === 'string' ? { id: first.id } : {}),
      value: first.value,
    };
  }
  return null;
}

function hasPendingContinuation(snapshot: unknown) {
  const record = readRecord(snapshot);
  const next = record?.next;
  if (Array.isArray(next) && next.length > 0) return true;
  const tasks = record?.tasks;
  return Array.isArray(tasks) && tasks.length > 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

async function timelineFixturePause() {
  // Keep each transient state visible across at least two 60 fps frames.
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function configurable(setup: AgentChannelSetup) {
  return {
    thread_id: setup.input.threadId,
  };
}
