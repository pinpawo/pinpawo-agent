import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolMessage, AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  projectHumanReviewRequest,
  readAgentMessageCreatedAt,
  SUBAGENT_OPERATIONS_EVENT,
} from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { LocalAgentGraphService } from './agentGraphService';
import { runAgentSessionTurn } from './chatSessionAdapter';
import { readFinalMessageText, type StreamToolsPayload } from './agentStreamEvents';

/** The reviews an interrupt.requested event carries, or [] for another kind. */
function reviewInteractions(event: AgentRuntimeEvent | undefined) {
  return event?.type === 'interrupt.requested'
    && event.pendingInterrupt.payload.kind === 'human_review'
    ? event.pendingInterrupt.payload.interactions
    : [];
}

/**
 * runAgentSessionTurn consumes the ROOT `streamEvents(v3)` protocol stream
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

test('runAgentSessionTurn does not settle before the underlying graph run output', async () => {
  let resolveOutput!: () => void;
  const output = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  let notifyStreamEnded!: () => void;
  const streamEnded = new Promise<void>((resolve) => {
    notifyStreamEnded = resolve;
  });
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const stream = Object.assign((async function* () {
    yield protocolEvent('values', { messages: [new AIMessage('done')] });
    notifyStreamEnded();
  })(), { output });
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents() {
      return stream;
    },
  };

  let settled = false;
  const run = runAgentSessionTurn({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn defers interrupted terminalization until graph output settles', async () => {
  let resolveOutput!: () => void;
  const output = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  let notifyIteratorClosed!: () => void;
  const iteratorClosed = new Promise<void>((resolve) => {
    notifyIteratorClosed = resolve;
  });
  const setup = {
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
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents() {
      return stream;
    },
  };
  let currentChecks = 0;
  let settled = false;

  const run = runAgentSessionTurn({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => {
      currentChecks += 1;
      return currentChecks === 1;
    },
    emitEvent: () => undefined,
    emitToolEvent: () => undefined,
  }).then((result) => {
    settled = true;
    return result;
  });

  await iteratorClosed;
  await Promise.resolve();
  // The interrupted result is the Host's cue to finalize; it must not be
  // reported before the graph run has settled.
  assert.equal(settled, false);

  resolveOutput();
  assert.deepEqual(await run, { status: 'interrupted' });
});

test('runAgentSessionTurn sources tool operations from the root protocol stream, not the callback', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: unknown[] = [];
  const setup = {
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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
  assert.match(readAgentMessageCreatedAt(setup.input.messages[0]!) ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/);
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

test('runAgentSessionTurn falls back to checkpoint final message when stream values omit messages', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const finalMessages = [
    new HumanMessage('hello'),
    new AIMessage('checkpoint answer'),
  ];
  const setup = {
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
        pendingInterrupt: null,
      };
    },
    streamEvents() {
      return (async function* () {})();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn replaces the current plan from root values and clears it at settlement', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const finalMessages = [new AIMessage('done')];
  let threadStateRead = 0;
  const graphService = {
    async readThreadState() {
      threadStateRead += 1;
      return {
        messages: threadStateRead === 1 ? [] : finalMessages,
        pendingInterrupt: null,
        currentPlan: null,
      };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', {
          messages: [new AIMessage({ content: '', additional_kwargs: { pinpawo: { runId: 'run', traceId: 'trace' } },
            tool_calls: [{ id: 'execution-call', name: 'delegate_capability', args: {
              control: { name: 'submit_plan', args: { tasks: [{ capability: 'explore', task: 'Inspect code' }] } },
              execution: { taskId: 'task-1', delegationId: 'delegation', capability: 'explore',
                task: 'Inspect code', mode: 'initial', guidance: null },
            } }] }), ...finalMessages],
          runSupervisorState: {
            goal: 'Inspect and verify',
            plan: [
              { id: 'task-1', capability: 'explore', task: 'Inspect code', status: 'pending' },
              { id: 'task-2', capability: 'browser', task: 'Verify result', status: 'pending' },
            ],
          },
        });
      })();
    },
  };

  await runAgentSessionTurn({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => emittedEvents.push(event),
    emitToolEvent: () => {},
  });

  const plans = emittedEvents.filter((event): event is Extract<AgentRuntimeEvent, { type: 'plan.updated' }> =>
    event.type === 'plan.updated');
  assert.deepEqual(plans, [{
    type: 'plan.updated',
    requestId: 'req-1',
    plan: {
      items: [
        {
          id: 'task-1',
          capability: 'explore',
          task: 'Inspect code',
          status: 'active',
        },
        {
          id: 'task-2',
          capability: 'browser',
          task: 'Verify result',
          status: 'pending',
        },
      ],
    },
  }, {
    type: 'plan.updated',
    requestId: 'req-1',
    plan: null,
  }]);
});

test('runAgentSessionTurn projects global policy authorization as completed operations', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn emits one completed subagent block per child model message lifecycle', async () => {
  const emittedTools: StreamToolsPayload[] = [];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn merges subagent_operations announcements through acceptDelegationOperations', async () => {
  const accepted: unknown[] = [];
  const setup = {
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('custom', {
          event: 'on_runtime_event',
          name: SUBAGENT_OPERATIONS_EVENT,
          data: {
            operations: {
              save_content_writer: { title: '保存报告' },
            },
          },
        }, ['capability:t1']);
        yield protocolEvent('values', { messages: [new AIMessage('done')] });
      })();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: () => {},
    emitToolEvent: () => {},
    acceptDelegationOperations: (operations) => {
      accepted.push(operations);
    },
  });

  assert.deepEqual(result, { status: 'completed', reply: 'done' });
  assert.deepEqual(accepted, [{
    save_content_writer: { title: '保存报告' },
  }]);
});

test('runAgentSessionTurn projects review interrupts to public interaction contracts', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
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
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', {
          __interrupt__: [{
            id: 'interrupt-1',
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

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'hello',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting' });
  const event = emittedEvents[0];
  assert.equal(event?.type, 'interrupt.requested');
  assert.deepEqual(reviewInteractions(event), [projectHumanReviewRequest(review)]);
});

test('runAgentSessionTurn resumes explicit response after state update clears interrupt payload', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const streamInputs: unknown[] = [];
  const resume = {
    interruptId: 'interrupt-1',
    value: { reviewId: 'review-1', selectedOptionId: 'approve' },
  };
  const finalMessages = [new AIMessage('approved')];
  const setup = {
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
        ? { messages: [], pendingInterrupt: null, acceptsResume: true }
        : { messages: finalMessages, pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents(_setup: AgentChannelSetup, resume?: unknown) {
      return (async function* () {
        streamInputs.push(resume);
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'resume',
      requestId: 'req-1',
      resume,
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'approved' });
  assert.deepEqual(streamInputs, [resume]);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(
    emittedEvents.some((event) => event.type === 'interrupt.requested'),
    false,
  );
});

test('runAgentSessionTurn reports waiting_human when a resume raises a new review', async () => {
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
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let reads = 0;
  const emittedEvents: AgentRuntimeEvent[] = [];
  const graphService = {
    async readThreadState() {
      reads += 1;
      return reads === 1
        ? {
          messages: [],
          pendingInterrupt: { interruptId: 'interrupt-original', payload: { kind: 'human_review', reviews: [originalReview] } },
        acceptsResume: true,
        }
        : {
          messages: [],
          pendingInterrupt: { interruptId: 'interrupt-next', payload: { kind: 'human_review', reviews: [nextReview] } },
        acceptsResume: true,
        };
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

  const result = await runAgentSessionTurn({
    request: { kind: 'resume', requestId: 'req-1', resume: { interruptId: 'interrupt-1', value: { approved: true } } },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting' });
  assert.equal(emittedEvents[0]?.type, 'interrupt.requested');
  assert.equal(reviewInteractions(emittedEvents[0])[0]?.interactionId, 'review-next');
});

test('runAgentSessionTurn rejects when graph execution fails during a resume', async () => {
  const review = {
    id: 'review-original',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return {
        messages: [],
        pendingInterrupt: { interruptId: 'interrupt-original', payload: { kind: 'human_review', reviews: [review] } },
        acceptsResume: true,
      };
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
    runAgentSessionTurn({
      request: { kind: 'resume', requestId: 'req-1', resume: { interruptId: 'interrupt-1', value: { approved: true } } },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /resume failed/,
  );
});

test('runAgentSessionTurn allows a user message after an aborted non-review run leaves pending continuation', async () => {
  const finalMessages = [new AIMessage('continued after abort')];
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
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
        ? { messages: [], pendingInterrupt: null, acceptsResume: true }
        : { messages: finalMessages, pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents(streamSetup: AgentChannelSetup, inputOverride?: unknown) {
      return (async function* () {
        streamInputs.push(inputOverride);
        assert.equal(readFinalMessageText(streamSetup.input.messages.at(-1) ?? {}), 'new request');
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: 'new request',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: 'continued after abort' });
  assert.deepEqual(streamInputs, [undefined]);
  assert.equal(
    emittedEvents.some((event) => event.type === 'interrupt.requested' || event.type === 'system.notice'),
    false,
  );
});

test('runAgentSessionTurn rejects stale resume with user-facing message', async () => {
  const setup = {
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
    },
    streamEvents() {
      throw new Error('should not stream');
    },
  };

  await assert.rejects(
    () => runAgentSessionTurn({
      request: {
        kind: 'resume',
        requestId: 'req-1',
        resume: {
          interruptId: 'interrupt-1',
          value: { reviewId: 'review-1', selectedOptionId: 'approve' },
        },
      },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /review 已关闭或不存在/,
  );
});

test('runAgentSessionTurn does not map pending review free text to review response', async () => {
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
    graphConfig: {},
    input: {
      messages: [],
    },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return {
        messages: [],
        pendingInterrupt: { interruptId: 'interrupt-1', payload: { kind: 'human_review', reviews: [review] } },
        acceptsResume: true,
      };
    },
    streamEvents(_setup: AgentChannelSetup, resume?: unknown) {
      return (async function* () {
        streamInputs.push(resume);
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '请先解释风险',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
    prepareUserMessage: async () => {
      preparedUserMessages += 1;
      return new HumanMessage('must not be admitted');
    },
  });

  assert.deepEqual(result, { status: 'waiting' });
  assert.deepEqual(streamInputs, []);
  assert.deepEqual(setup.input.messages, []);
  assert.equal(preparedUserMessages, 0);
  assert.equal(emittedEvents[0]?.type, 'system.notice');
  assert.match(
    emittedEvents[0]?.type === 'system.notice' ? emittedEvents[0].message : '',
    /确认面板/,
  );
  assert.equal(emittedEvents[1]?.type, 'interrupt.requested');
  assert.deepEqual(
    reviewInteractions(emittedEvents[1])[0],
    projectHumanReviewRequest(review),
  );
});

test('runAgentSessionTurn degrades a GraphRecursionError to a completed 待续跑 reply', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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

  const result = await runAgentSessionTurn({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn keeps the streamed reply when GraphRecursionError fires mid-stream', async () => {
  const emittedEvents: AgentRuntimeEvent[] = [];
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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

  const result = await runAgentSessionTurn({
    request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => { emittedEvents.push(event); },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'completed', reply: '部分进度' });
});

test('runAgentSessionTurn rethrows non-recursion errors from the stream', async () => {
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;

  const graphService = {
    async readThreadState() {
      return { messages: [], pendingInterrupt: null, acceptsResume: false };
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
    () => runAgentSessionTurn({
      request: { kind: 'user_message', requestId: 'req-1', message: 'hello' },
      setup,
      graphService: graphService as unknown as LocalAgentGraphService,
      isCurrent: () => true,
      emitEvent: () => {},
      emitToolEvent: () => {},
    }),
    /some other failure/,
  );
});

test('runAgentSessionTurn omits token usage when provider usage is unavailable', async () => {
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
        pendingInterrupt: null,
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

  const result = await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '你是谁？',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn emits provider token usage from new state messages', async () => {
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
        pendingInterrupt: null,
      };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', { messages: finalMessages });
      })();
    },
  };

  await runAgentSessionTurn({
    request: {
      kind: 'user_message',
      requestId: 'req-1',
      message: '你是谁？',
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
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

test('runAgentSessionTurn reports a task pause without turning its bookkeeping into an assistant reply', async () => {
  // Regression: after a Review reject the run settles into a task pause. The
  // checkpoint's last message is the rejected tool result — it is not a reply,
  // and the run must not be reported as completed.
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [
      { id: 'approve', label: 'Approve', decision: { type: 'approve' as const } },
      { id: 'reject', label: 'Reject', decision: { type: 'reject' as const, message: 'no' } },
    ],
  };
  const rejectedResult = new ToolMessage({
    content: JSON.stringify({ source: 'human_reject', message: 'no' }),
    tool_call_id: 'call-1',
    name: 'run_shell',
  });
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  let reads = 0;
  const emittedEvents: AgentRuntimeEvent[] = [];
  const graphService = {
    async readThreadState() {
      reads += 1;
      return reads === 1
        ? {
          messages: [],
          pendingInterrupt: { interruptId: 'interrupt-1', payload: { kind: 'human_review', reviews: [review] } },
        acceptsResume: true,
        }
        : {
          // The reject settled into a task pause, which is a pending
          // interrupt with an id like any other.
          messages: [rejectedResult],
          pendingInterrupt: { interruptId: 'interrupt-pause', payload: { kind: 'pause_task' } },
          acceptsResume: true,
        };
    },
    streamEvents() {
      return (async function* () {})();
    },
  };

  const result = await runAgentSessionTurn({
    request: {
      kind: 'resume',
      requestId: 'req-1',
      resume: {
        interruptId: 'interrupt-1',
        value: { decisions: [{ reviewId: 'review-1', selectedOptionId: 'reject' }] },
      },
    },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: (event) => {
      emittedEvents.push(event);
    },
    emitToolEvent: () => {},
  });

  assert.deepEqual(result, { status: 'waiting' });
  assert.equal(emittedEvents.some((event) => event.type === 'message.completed'), false);
  assert.equal(JSON.stringify(emittedEvents).includes('human_reject'), false);
  // The pause is announced by id, so the interface can continue it without
  // inferring anything from the run's ending.
  const requested = emittedEvents.find((event) => event.type === 'interrupt.requested');
  assert.deepEqual(
    requested?.type === 'interrupt.requested' ? requested.pendingInterrupt : null,
    { interruptId: 'interrupt-pause', payload: { kind: 'pause_task' } },
  );
});

test('runAgentSessionTurn accepts a streamed task-pause interrupt from a rebuilt graph', async () => {
  const setup = {
    graphConfig: {},
    input: { messages: [] },
  } as unknown as AgentChannelSetup;
  const graphService = {
    async readThreadState() {
      return {
        messages: [],
        pendingInterrupt: null,
        acceptsResume: true,
      };
    },
    streamEvents() {
      return (async function* () {
        yield protocolEvent('values', {
          __interrupt__: [{ id: 'pause-1', value: { kind: 'pause_task' } }],
        });
      })();
    },
  };

  assert.deepEqual(await runAgentSessionTurn({
    request: { kind: 'resume', requestId: 'req-1', resume: { interruptId: 'interrupt-1', value: { action: 'cancel' } } },
    setup,
    graphService: graphService as unknown as LocalAgentGraphService,
    isCurrent: () => true,
    emitEvent: () => {},
    emitToolEvent: () => {},
  }), { status: 'waiting' });
});
