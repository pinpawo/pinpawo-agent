import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  readMessageCreatedAtUtc,
  SUBAGENT_OPERATIONS_EVENT,
} from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { LocalAgentGraphService } from './agentGraphService';
import { runChatSession } from './chatSessionAdapter';
import { readFinalMessageText, type StreamToolsPayload } from './agentStreamEvents';

/**
 * runChatSession consumes the ROOT `streamEvents(v3)` protocol stream
 * (#322 Phase 4); the fakes below emit raw protocol events.
 */
function protocolEvent(method: string, data: unknown, namespace: string[] = []) {
  return { type: 'event' as const, seq: 0, method, params: { namespace, data } };
}

/** A full model message lifecycle in one namespace. */
function messageLifecycle(text: string, namespace: string[] = [], id = 'msg-1') {
  return [
    protocolEvent('messages', { event: 'message-start', id }, namespace),
    protocolEvent('messages', {
      event: 'content-block-delta',
      delta: { type: 'text-delta', text },
    }, namespace),
    protocolEvent('messages', { event: 'message-finish' }, namespace),
  ];
}

test('runChatSession does not settle before the underlying graph run output', async () => {
  let resolveOutput!: () => void;
  const output = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  let notifyStreamEnded!: () => void;
  const streamEnded = new Promise<void>((resolve) => {
    notifyStreamEnded = resolve;
  });
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const stream = Object.assign((async function* () {
    yield protocolEvent('values', { messages: [new AIMessage('done')] });
    notifyStreamEnded();
  })(), { output });
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return stream;
    },
  };

  let settled = false;
  const run = runChatSession({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: () => undefined,
    emitToolEvent: () => undefined,
  }).then((result) => {
    settled = true;
    return result;
  });

  await streamEnded;
  await Promise.resolve();
  assert.equal(settled, false);

  resolveOutput();
  assert.deepEqual(await run, { status: 'completed', reply: 'done' });
});

test('runChatSession defers interrupted terminalization until graph output settles', async () => {
  let resolveOutput!: () => void;
  const output = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  let notifyIteratorClosed!: () => void;
  const iteratorClosed = new Promise<void>((resolve) => {
    notifyIteratorClosed = resolve;
  });
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const stream = Object.assign((async function* () {
    try {
      yield protocolEvent('values', { messages: [new AIMessage('late')] });
    } finally {
      notifyIteratorClosed();
    }
  })(), { output });
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return stream;
    },
  };
  let currentChecks = 0;
  let interruptedCalls = 0;
  let settled = false;

  const run = runChatSession({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => {
      currentChecks += 1;
      return currentChecks === 1;
    },
    finishInterrupted: () => {
      interruptedCalls += 1;
    },
    emitEvent: () => undefined,
    emitToolEvent: () => undefined,
  }).then((result) => {
    settled = true;
    return result;
  });

  await iteratorClosed;
  await Promise.resolve();
  assert.equal(interruptedCalls, 0);
  assert.equal(settled, false);

  resolveOutput();
  assert.deepEqual(await run, { status: 'interrupted' });
  assert.equal(interruptedCalls, 1);
});

test('runChatSession sources tool operations from the root protocol stream, not the callback', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: unknown[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('tools', {
          event: 'tool-started',
          tool_call_id: 'stream-call',
          tool_name: 'stream_source',
          input: { source: 'stream' },
        }, ['general:t1', 'tools:t2']);
        yield protocolEvent('tools', {
          event: 'tool-finished',
          tool_call_id: 'stream-call',
          output: 'ok',
        }, ['general:t1', 'tools:t2']);
        yield protocolEvent('values', { messages: [new AIMessage('done')] });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.equal(setup.input.messages.length, 1);
  assert.equal(setup.input.messages[0]?._getType(), 'human');
  assert.equal(readFinalMessageText(setup.input.messages[0] ?? {}), 'hello');
  assert.match(readMessageCreatedAtUtc(setup.input.messages[0]!) ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(emittedTools, [
    {
      event: 'on_tool_start',
      toolCallId: 'stream-call',
      name: 'stream_source',
      input: { source: 'stream' },
    },
    {
      event: 'on_tool_end',
      toolCallId: 'stream-call',
      name: 'stream_source',
      output: 'ok',
    },
  ]);
  assert.equal(
    emittedEvents.some((event) =>
      Boolean(event && typeof event === 'object' && (event as { type?: unknown }).type === 'message.completed'),
    ),
    true,
  );
});

test('runChatSession falls back to checkpoint final message when stream values omit messages', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const finalMessages = [
    new HumanMessage('hello'),
    new AIMessage('checkpoint answer'),
  ];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return {
        messages: readThreadStateCalls === 1 ? [] : finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    streamEvents() {
      return (async function* () {})();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'checkpoint answer' });
  assert.equal(readThreadStateCalls, 2);
  const completed = emittedEvents.find(
    (event): event is Extract<AgentRuntimeEvent, { type: 'message.completed' }> =>
      event.type === 'message.completed',
  ) ?? null;
  assert.equal(completed?.text, 'checkpoint answer');
});

test('runChatSession projects global policy authorization as completed operations', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        // Toolkit authorization runtime events ride the stream writer and
        // arrive as `custom` protocol events (#322).
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED,
          data: {
            toolName: 'write_file',
            policyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
            batchSize: 1,
            reason: 'The write is limited to the workspace.',
            toolCalls: [{ toolkitName: 'workspace', toolName: 'write_file' }],
          },
        }, ['general:t1']);
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED,
          data: {
            toolName: 'custom_tool',
            policyMode: GLOBAL_REVIEW_POLICY_MODE.CUSTOM,
            batchSize: 1,
            reason: 'The configured policy approved this action.',
            toolCalls: [{ toolkitName: 'custom', toolName: 'custom_tool' }],
          },
        }, ['general:t1']);
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: 'tool_authorization_recorded',
          data: {
            toolName: 'write_file',
            matcherType: 'exact',
            source: 'auto_review',
            scope: 'thread',
          },
        }, ['general:t1']);
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: 'tool_authorization_recorded',
          data: {
            toolName: 'run_shell',
            matcherType: 'exact',
            source: 'human',
            scope: 'thread',
          },
        }, ['general:t1']);
        yield protocolEvent('values', { messages: [new AIMessage('done')] });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(emittedTools, []);
  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'operation'),
    [{
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: `authorization:${GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED}:0`,
        kind: 'runtime.authorization',
        title: '自动授权',
        summary: 'workspace · write_file',
        details: {
          toolLabels: ['workspace · write_file'],
          reason: 'The write is limited to the workspace.',
        },
        source: {
          provider: 'runtime',
          name: 'global_review_policy',
        },
      },
    }, {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: `authorization:${GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED}:0`,
        kind: 'runtime.authorization',
        title: '按策略授权',
        summary: 'custom · custom_tool',
        details: {
          toolLabels: ['custom · custom_tool'],
          reason: 'The configured policy approved this action.',
        },
        source: {
          provider: 'runtime',
          name: 'global_review_policy',
        },
      },
    }],
  );
  assert.deepEqual(
    emittedEvents
      .filter((event) => event.type === 'system.notice')
      .map((event) => event.message),
    [
      '已授权当前会话中的 run_shell 操作。',
    ],
  );
});

test('runChatSession emits one completed subagent block per child model message lifecycle', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        // A child scope (namespace depth >= 2) streams a model message in two
        // deltas; the consumer gets ONE completed block.
        const namespace = ['general:t1', 'model_request:t2'];
        yield protocolEvent('messages', { event: 'message-start', id: 'child-1' }, namespace);
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: { type: 'text-delta', text: '正在' },
        }, namespace);
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: { type: 'text-delta', text: '整理' },
        }, namespace);
        yield protocolEvent('messages', { event: 'message-finish' }, namespace);
        yield protocolEvent('values', { messages: [new AIMessage('done')] });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: (event) => {
      emittedTools.push(event);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(emittedTools, []);
  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'subagent.message.completed'),
    [{
      type: 'subagent.message.completed',
      requestId: 'req-1',
      messageId: 'child-1',
      namespace: ['general:t1', 'model_request:t2'],
      text: '正在整理',
    }],
  );
});

test('runChatSession merges subagent_operations announcements through acceptDelegationOperations', async () => {
  const accepted: unknown[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: SUBAGENT_OPERATIONS_EVENT,
          data: {
            operations: {
              save_daily_post: { title: '保存日报' },
            },
          },
        }, ['capability:t1']);
        yield protocolEvent('values', { messages: [new AIMessage('done')] });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: () => {},
    emitToolEvent: () => {},
    acceptDelegationOperations: (operations) => {
      accepted.push(operations);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(accepted, [{
    save_daily_post: { title: '保存日报' },
  }]);
});

test('runChatSession forwards canonical review interrupt specs unchanged', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const review = {
    id: 'review-direct',
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      title: 'Shell command approval',
      body: 'Run git status?',
    },
    options: [{
      id: 'approve',
      label: 'Approve',
      decision: { type: 'approve' as const },
    }],
  };
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', {
          __interrupt__: [{
            value: {
              kind: 'review',
              review,
              pendingAction: {
                actionId: 'call-1',
                toolName: 'run_shell',
                args: { command: 'git status', cwd: '/repo' },
                description: 'Run git status?',
              },
            },
          }],
        });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting_human' });
  const event = emittedEvents[0];
  assert.equal(event?.type, 'human_review.requested');
  assert.deepEqual(event.review, review);
});

test('runChatSession resumes explicit response after state update clears interrupt payload', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const streamInputs: unknown[] = [];
  let resumeCheckpointedCount = 0;
  const resume = { reviewId: 'review-1', selectedOptionId: 'approve' };
  const finalMessages = [new AIMessage('approved')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return readThreadStateCalls === 1
        ? { messages: [], pendingHumanReview: null, hasPendingContinuation: true }
        : { messages: finalMessages, pendingHumanReview: null, hasPendingContinuation: false };
    },
    buildResumeCommand(value: unknown) {
      return { kind: 'resume-command', value };
    },
    streamEvents(_setup: AgentChannelSetup, inputOverride?: unknown) {
      return (async function* () {
        streamInputs.push(inputOverride);
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'resume',
      requestId: 'req-1',
      resume,
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
    onResumeCheckpointed: () => {
      resumeCheckpointedCount += 1;
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'approved' });
  assert.deepEqual(streamInputs, [{
    kind: 'resume-command',
    value: resume,
  }]);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(resumeCheckpointedCount, 1);
  assert.equal(
    emittedEvents.some((event) => event.type === 'human_review.requested'),
    false,
  );
});

test('runChatSession does not confirm a review resolution while checkpoint keeps the original review', async () => {
  const review = {
    id: 'review-original',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const pending = {
    interruptId: 'interrupt-original',
    review,
  };
  const finalMessages = [new AIMessage('continued')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let reads = 0;
  let boundary = 0;
  const confirmedAt: number[] = [];
  const graphService = {
    async readThreadState() {
      reads += 1;
      if (reads <= 2) {
        return { messages: [], pendingHumanReview: pending, hasPendingContinuation: true };
      }
      return { messages: finalMessages, pendingHumanReview: null, hasPendingContinuation: false };
    },
    buildResumeCommand(value: unknown) {
      return value;
    },
    streamEvents() {
      return (async function* () {
        boundary = 1;
        yield protocolEvent('values', { messages: [] });
        boundary = 2;
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: { kind: 'resume', requestId: 'req-1', resume: { approved: true } },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => { throw new Error('should not interrupt'); },
    emitEvent: () => {},
    emitToolEvent: () => {},
    onResumeCheckpointed: () => {
      confirmedAt.push(boundary);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'continued' });
  assert.deepEqual(confirmedAt, [2]);
});

test('runChatSession confirms the original resolution without interrupting a newly pending review', async () => {
  const originalReview = {
    id: 'review-original',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'First approval?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const nextReview = {
    ...originalReview,
    id: 'review-next',
    view: { kind: 'plain' as const, body: 'Second approval?' },
  };
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let reads = 0;
  const confirmations: Array<{ canInterrupt: boolean }> = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const graphService = {
    async readThreadState() {
      reads += 1;
      return reads === 1
        ? {
          messages: [],
          pendingHumanReview: { interruptId: 'interrupt-original', review: originalReview },
          hasPendingContinuation: true,
        }
        : {
          messages: [],
          pendingHumanReview: { interruptId: 'interrupt-next', review: nextReview },
          hasPendingContinuation: true,
        };
    },
    buildResumeCommand(value: unknown) {
      return value;
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', {
          __interrupt__: [{
            id: 'interrupt-next',
            value: { kind: 'review', review: nextReview },
          }],
        });
      })();
    },
  };

  const result = await runChatSession({
    request: { kind: 'resume', requestId: 'req-1', resume: { approved: true } },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => { throw new Error('should not interrupt'); },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
    onResumeCheckpointed: (confirmation) => {
      confirmations.push(confirmation);
    },
  });

  assert.deepEqual(result, { status: 'waiting_human' });
  assert.deepEqual(confirmations, [{ canInterrupt: false }]);
  assert.equal(emittedEvents[0]?.type, 'human_review.requested');
  assert.equal(
    emittedEvents[0]?.type === 'human_review.requested'
      ? emittedEvents[0].review.id
      : null,
    'review-next',
  );
});

test('runChatSession does not confirm a review resolution when graph execution fails first', async () => {
  const review = {
    id: 'review-original',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let confirmations = 0;
  const graphService = {
    async readThreadState() {
      return {
        messages: [],
        pendingHumanReview: { interruptId: 'interrupt-original', review },
        hasPendingContinuation: true,
      };
    },
    buildResumeCommand(value: unknown) {
      return value;
    },
    streamEvents() {
      return (async function* () {
        throw new Error('resume failed');
        // eslint-disable-next-line no-unreachable
        yield protocolEvent('values', {});
      })();
    },
  };

  await assert.rejects(
    runChatSession({
      request: { kind: 'resume', requestId: 'req-1', resume: { approved: true } },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      finishInterrupted: () => { throw new Error('should not interrupt'); },
      emitEvent: () => {},
      emitToolEvent: () => {},
      onResumeCheckpointed: () => {
        confirmations += 1;
      },
    }),
    /resume failed/,
  );
  assert.equal(confirmations, 0);
});

test('runChatSession preserves review cancellation when the active checkpoint read fails', async () => {
  const review = {
    id: 'review-original',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const finalMessages = [new AIMessage('must not be reported as completed')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let reads = 0;
  let current = true;
  let finishInterruptedCount = 0;
  const emittedEvents: AgentRuntimeEvent[] = [];
  const graphService = {
    async readThreadState() {
      reads += 1;
      if (reads === 1) {
        return {
          messages: [],
          pendingHumanReview: { interruptId: 'interrupt-original', review },
          hasPendingContinuation: true,
        };
      }
      if (reads === 2) {
        throw new Error('transient checkpoint read failure');
      }
      return {
        messages: finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    buildResumeCommand(value: unknown) {
      return value;
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'resume',
      requestId: 'req-1',
      resume: { action: 'interrupt_run' },
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => current,
    finishInterrupted: () => {
      finishInterruptedCount += 1;
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
    interruptOnSettledResumeCheckpoint: true,
    onResumeCheckpointed: ({ canInterrupt }) => {
      assert.equal(canInterrupt, true);
      current = false;
    },
  });

  assert.deepEqual(result, { status: 'interrupted' });
  assert.equal(finishInterruptedCount, 1);
  assert.equal(
    emittedEvents.some((event) => event.type === 'message.completed'),
    false,
  );
});

test('runChatSession allows a user message after an aborted non-review run leaves pending continuation', async () => {
  const finalMessages = [new AIMessage('continued after abort')];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const streamInputs: unknown[] = [];
  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return readThreadStateCalls === 1
        ? { messages: [], pendingHumanReview: null, hasPendingContinuation: true }
        : { messages: finalMessages, pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents(streamSetup: AgentChannelSetup, inputOverride?: unknown) {
      return (async function* () {
        streamInputs.push(inputOverride);
        assert.equal(readFinalMessageText(streamSetup.input.messages.at(-1) ?? {}), 'new request');
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'new request',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'continued after abort' });
  assert.deepEqual(streamInputs, [undefined]);
  assert.equal(
    emittedEvents.some((event) => event.type === 'human_review.requested' || event.type === 'system.notice'),
    false,
  );
});

test('runChatSession rejects stale resume with user-facing message', async () => {
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    buildResumeCommand() {
      throw new Error('should not build resume command');
    },
    streamEvents() {
      throw new Error('should not stream');
    },
  };

  await assert.rejects(
    () => runChatSession({
      request: {
        kind: 'resume',
        requestId: 'req-1',
        resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
      },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      finishInterrupted: () => {
        throw new Error('should not interrupt');
      },
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /review 已关闭或不存在/,
  );
});

test('runChatSession does not map pending review free text to review response', async () => {
  const streamInputs: unknown[] = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  let preparedUserMessages = 0;
  const review = {
    id: 'review-respond',
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      body: 'Need guidance?',
    },
    options: [{
      id: 'respond',
      label: 'Respond',
      input: {
        kind: 'text' as const,
        key: 'message' as const,
        required: true,
      },
      decision: { type: 'respond' as const, messageInputKey: 'message' as const },
    }],
  };
  const finalMessages = [new AIMessage('continued')];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: { review }, hasPendingContinuation: true };
    },
    buildResumeCommand(value: unknown) {
      throw new Error(`should not build resume command: ${String(value)}`);
    },
    streamEvents(_setup: AgentChannelSetup, inputOverride?: unknown) {
      return (async function* () {
        streamInputs.push(inputOverride);
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '请先解释风险',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
    prepareUserMessage: async () => {
      preparedUserMessages += 1;
      return new HumanMessage('must not be admitted');
    },
  });

  assert.deepEqual(result, { status: 'waiting_human' });
  assert.deepEqual(streamInputs, []);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(preparedUserMessages, 0);
  assert.equal(emittedEvents[0]?.type, 'system.notice');
  assert.match(
    emittedEvents[0]?.type === 'system.notice' ? emittedEvents[0].message : '',
    /确认面板/,
  );
  assert.equal(emittedEvents[1]?.type, 'human_review.requested');
  assert.deepEqual(
    emittedEvents[1]?.type === 'human_review.requested' ? emittedEvents[1].review : null,
    review,
  );
});

test('runChatSession degrades a GraphRecursionError to a completed 待续跑 reply', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        const error = new Error('Recursion limit of 135 reached without hitting a stop condition.');
        (error as { lc_error_code?: string }).lc_error_code = 'GRAPH_RECURSION_LIMIT';
        throw error;
        // eslint-disable-next-line no-unreachable
        yield protocolEvent('values', { messages: [] });
      })();
    },
  };

  const result = await runChatSession({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => { throw new Error('should not interrupt'); },
    emitEvent: (event) => { emittedEvents.push(event); },
    emitToolEvent: () => {},
  });

  assert.equal(result.status, 'completed');
  assert.match(result.status === 'completed' ? result.reply : '', /步数已达上限/);
  const completed = emittedEvents.find(
    (event): event is Extract<AgentRuntimeEvent, { type: 'message.completed' }> =>
      event.type === 'message.completed',
  ) ?? null;
  assert.match(completed?.text ?? '', /步数已达上限/);
});

test('runChatSession keeps the streamed reply when GraphRecursionError fires mid-stream', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('messages', { event: 'message-start', id: 'main-1' });
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: { type: 'text-delta', text: '部分进度' },
        });
        throw new Error('GRAPH_RECURSION_LIMIT');
      })();
    },
  };

  const result = await runChatSession({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => { throw new Error('should not interrupt'); },
    emitEvent: (event) => { emittedEvents.push(event); },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: '部分进度' });
});

test('runChatSession rethrows non-recursion errors from the stream', async () => {
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingHumanReview: null, hasPendingContinuation: false };
    },
    streamEvents() {
      return (async function* () {
        throw new Error('some other failure');
        // eslint-disable-next-line no-unreachable
        yield protocolEvent('values', { messages: [] });
      })();
    },
  };

  await assert.rejects(
    () => runChatSession({
      request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      finishInterrupted: () => {},
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /some other failure/,
  );
});

test('runChatSession omits token usage when provider usage is unavailable', async () => {
  const emittedEvents: unknown[] = [];
  const promptMessages = [
    new HumanMessage('历史问题'),
    new AIMessage('历史回答'),
    new HumanMessage('你是谁？'),
  ];
  const snapshotMessages = [
    new HumanMessage('已保存的历史消息'),
  ];
  const finalMessages = [
    ...snapshotMessages,
    ...promptMessages,
    new AIMessage('这里是回执。'),
  ];
  const setup = {
    graphKey: 'test',
    graphConfig: {},
    input: {
      messages: promptMessages,
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return {
        messages: readThreadStateCalls === 1 ? snapshotMessages : finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    streamEvents() {
      return (async function* () {
        for (const event of messageLifecycle('你好，')) {
          yield event;
        }
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '你是谁？',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: '这里是回执。' });
  const completed = (emittedEvents as AgentRuntimeEvent[])
    .find((message): message is AgentRuntimeEvent => message.type === 'message.completed') ?? null;
  assert.equal(completed?.type, 'message.completed');
  assert.equal(completed?.role, 'assistant');
  assert.equal(completed.usage, undefined);
});

test('runChatSession emits provider token usage from new state messages', async () => {
  const emittedEvents: unknown[] = [];
  const historicalReply = new AIMessage({
    content: '历史回答。',
    usage_metadata: {
      input_tokens: 900,
      output_tokens: 100,
      total_tokens: 1000,
    },
  });
  historicalReply.id = 'history-ai-1';
  const promptMessages = [
    new HumanMessage('你是谁？'),
  ];
  const finalReply = new AIMessage({
    content: '这里是回执。',
    usage_metadata: {
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
    },
  });
  finalReply.id = 'reply-ai-1';
  const initialMessages = [
    new HumanMessage('之前的问题'),
    historicalReply,
  ];
  const finalMessages = [
    ...initialMessages,
    ...promptMessages,
    finalReply,
  ];
  const setup = {
    graphKey: 'test',
    graphConfig: {
      contextWindowTokens: 64000,
    },
    input: {
      messages: promptMessages,
    },
  } as unknown as AgentChannelSetup;

  let readThreadStateCalls = 0;
  const graphService = {
    async readThreadState() {
      readThreadStateCalls += 1;
      return {
        messages: readThreadStateCalls === 1 ? initialMessages : finalMessages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  await runChatSession({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '你是谁？',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    finishInterrupted: () => {
      throw new Error('should not interrupt');
    },
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  const completed = (emittedEvents as AgentRuntimeEvent[])
    .find((message): message is AgentRuntimeEvent => message.type === 'message.completed') ?? null;
  assert.equal(completed?.type, 'message.completed');
  assert.deepEqual(completed.usage, {
    inputTokens: 123,
    outputTokens: 45,
    totalTokens: 168,
    latestInputTokens: 123,
    contextWindow: 64000,
    updatedAt: completed.usage?.updatedAt,
    source: 'provider',
    scope: 'run',
  });
  assert.equal(typeof completed.usage?.updatedAt, 'string');
});
