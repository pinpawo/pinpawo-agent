import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHumanReviewRequest } from '@pinpawo/pet-agent';
import type { HumanReviewResponseMessage } from '@pinpawo/agent-session';
import { isToolProtocolHistoryError, ServerChatHandler } from './serverChatHandler';
import { InflightRequestController } from './inflightRequestController';
import type { ServerPeer } from './localServerPeer';

function createFakePeer(
  sent: unknown[] = [],
  isConnected: () => boolean = () => true,
): ServerPeer {
  return {
    isConnected,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
}

function interruptedRuns(sent: unknown[]): string[] {
  return sent.flatMap((item) => {
    const envelope = item as { type?: string; event?: { type?: string; requestId?: string } };
    return envelope.type === 'event' && envelope.event?.type === 'run.interrupted'
      ? [envelope.event.requestId ?? '']
      : [];
  });
}

function humanReviewResponse(
  interactionId: string,
  selectedOptionId = 'approve',
  input?: HumanReviewResponseMessage['responses'][number]['input'],
  interruptId = 'interrupt-1',
): HumanReviewResponseMessage {
  return {
    type: 'human_review_response',
    requestId: 'req-1',
    interruptId,
    responses: [{
      interactionId,
      selectedOptionId,
      ...(input ? { input } : {}),
    }],
  };
}

test('isToolProtocolHistoryError recognizes LangGraph tool history protocol failures', () => {
  assert.equal(isToolProtocolHistoryError(new Error('INVALID_TOOL_RESULTS')), true);
  assert.equal(isToolProtocolHistoryError(new Error("An assistant message with 'tool_calls' must be followed by tool messages")), true);
  assert.equal(isToolProtocolHistoryError('insufficient tool messages following tool_calls message'), true);
  assert.equal(isToolProtocolHistoryError(new Error('ordinary model error')), false);
});

test('local server forwards structured local attachments to the chat session', async () => {
  const peer = createFakePeer();
  let receivedRequest: unknown;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getChatThreadId: () => 'thread-x',
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
      refreshActiveSessionSummary: async () => undefined,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => undefined,
      sendControl: () => undefined,
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async (options) => {
      receivedRequest = options.request;
      return { status: 'completed', reply: 'done' };
    },
  });

  await handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'request-1',
    message: 'inspect this',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'directory',
      path: '/tmp/project',
      name: 'project',
    }],
  }, { petId: 'pet-1' } as never);

  assert.deepEqual(receivedRequest, {
    kind: 'user_message',
    requestId: 'request-1',
    message: 'inspect this',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'directory',
      path: '/tmp/project',
      name: 'project',
    }],
  });
});

test('replacement request waits for the previous thread invocation to settle', async () => {
  const sent: unknown[] = [];
  const controls: unknown[] = [];
  const peer = createFakePeer(sent);
  let notifyFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  let notifyFirstAborted!: () => void;
  const firstAborted = new Promise<void>((resolve) => {
    notifyFirstAborted = resolve;
  });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let replacementStarted = false;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getChatThreadId: () => 'thread-x',
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
      refreshActiveSessionSummary: async () => undefined,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => {
        controls.push(message);
      },
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async (options) => {
      if (options.request.requestId !== 'req-old') {
        replacementStarted = true;
        return { status: 'completed', reply: 'replacement completed' };
      }
      notifyFirstStarted();
      const signal = options.setup.input.signal;
      assert.ok(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      options.emitEvent({
        type: 'message.delta',
        requestId: 'req-old',
        messageId: 'm-1',
        role: 'assistant',
        text: 'late stale output',
      });
      notifyFirstAborted();
      await firstReleased;
      return { status: 'interrupted', reply: '' };
    },
  });
  const deps = { petId: 'pet-1' } as never;

  const oldRun = handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'req-old',
    message: 'old request',
  }, deps);
  await firstStarted;
  const replacementRun = handler.handleChatRequest(peer, {
    type: 'chat_request',
    requestId: 'req-new',
    message: 'new request',
  }, deps);
  await firstAborted;
  assert.equal(replacementStarted, false);
  assert.equal(
    sent.some((item) => JSON.stringify(item).includes('late stale output')),
    false,
  );

  releaseFirst();
  await Promise.all([oldRun, replacementRun]);
  assert.equal(replacementStarted, true);
  // A superseded run reports once through its runtime event; there is no
  // separate control message for a finished interruption.
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), ['req-old']);
});

test('run interrupt supersedes an unstarted response and cancels through the pending checkpoint', async () => {
  const controls: unknown[] = [];
  const sent: unknown[] = [];
  let runCount = 0;
  const fakePeer = createFakePeer(sent);
  const inflightRequests = new InflightRequestController<ServerPeer>({
    emitOperation: () => undefined,
    sendControl: (_peer, message) => {
      controls.push(message);
    },
  });
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      refreshActiveSessionSummary: async () => {},
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }],
      }),
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests,
    loadContext: async () => ({} as never),
    runAgentTurn: async (options) => {
      runCount += 1;
      // A review cancellation settles into a task pause; the handler finalizes it.
      return { status: 'paused' };
    },
  });
  const resolution = handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );
  assert.equal(await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-1',
  }, { petId: 'pet-1' } as never), null);

  await resolution;

  assert.equal(runCount, 1);
  assert.deepEqual(controls, []);
  // Both invocations carry the client's requestId: the unstarted response that
  // was superseded, and the cancellation that settled into a task pause.
  assert.deepEqual(interruptedRuns(sent), ['req-1', 'req-1']);
});

test('run interrupt cancels a review that became pending before the client observed it', async () => {
  const controls: unknown[] = [];
  const requests: unknown[] = [];
  const sent: unknown[] = [];
  const fakePeer = createFakePeer(sent);
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      refreshActiveSessionSummary: async () => {},
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-race',
        reviews: [{
          id: 'review-race',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }],
      }),
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests: new InflightRequestController<ServerPeer>({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => controls.push(message),
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async (options) => {
      requests.push(options.request);
      // A review cancellation settles into a task pause; the handler finalizes it.
      return { status: 'paused' };
    },
  });
  // The TUI chose run.interrupt from stale thinking state, but the active
  // checkpoint already contains the interrupt.

  const result = await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-race',
  }, { petId: 'pet-1' } as never);

  assert.equal(result, null);
  assert.deepEqual(requests, [{
    kind: 'resume',
    requestId: 'req-race',
    resume: {
      'interrupt-race': { action: 'interrupt_run' },
    },
  }]);
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), ['req-race']);
});

test('handleHumanReviewResponse rejects a stale canonical interactionId before forwarding', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => ({
      sessionId: 'sess-active',
      interruptId: 'interrupt-1',
      reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }],
    }),
  } as never;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-old'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as {
    type: string;
    event?: { type: string; requestId: string; message: string; code?: string };
  };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.equal(event.event?.requestId, 'req-1');
  assert.match(event.event?.message ?? '', /过期/);
  assert.equal(event.event?.code, 'review_stale');
});

test('handleHumanReviewResponse consumes matching canonical review route once', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  let pendingInterrupt: unknown = {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    reviews: [{
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    }],
  };
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => pendingInterrupt,
  } as never;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
    pendingInterrupt = null;
    return 'completed';
  };

  const message = humanReviewResponse('review-current');
  await handler.handleHumanReviewResponse(fakePeer, message, { petId: 'pet-1' } as never);
  await handler.handleHumanReviewResponse(fakePeer, message, { petId: 'pet-1' } as never);

  assert.equal(handleChatCalls.length, 1, 'matching review response should be forwarded once');
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    interactionId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
  assert.equal(sentEvents.length, 1, 'second response should be rejected after route is consumed');
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
  assert.equal(event.event?.code, 'review_closed');

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    { petId: 'pet-1' } as never,
  );
  assert.equal((sentEvents.at(-1) as { event?: { code?: string } }).event?.code, 'review_closed');
});

test('handleHumanReviewResponse keeps single-review review as batch resume shape', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [review],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{ reviewId: 'review-current', selectedOptionId: 'approve' }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    interactionId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
});

test('handleHumanReviewResponse recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
});

test('handleHumanReviewResponse releases a recovered review when its peer disconnects', async () => {
  let connected = false;
  const handleChatCalls: unknown[] = [];
  const fakePeer = createFakePeer([], () => connected);
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  const message = humanReviewResponse('review-current');

  await handler.handleHumanReviewResponse(fakePeer, message, { petId: 'pet-1' } as never);
  assert.equal(handleChatCalls.length, 0);

  connected = true;
  await handler.handleHumanReviewResponse(fakePeer, message, { petId: 'pet-1' } as never);
  assert.equal(handleChatCalls.length, 1);
});

test('buildPendingInterruptSnapshot projects the active checkpoint interrupt', () => {
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        reviews: [review],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  assert.deepEqual(handler.buildPendingInterruptSnapshot({ petId: 'pet-1' } as never, {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    reviews: [review],
  }), {
    sessionId: 'sess-active',
    pendingInterrupt: {
      interruptId: 'interrupt-1',
      payload: {
        kind: 'human_review',
        interactions: [projectHumanReviewRequest(review)],
      },
    },
  });
});

test('handleReviewCancel resumes pending review with run interruption control', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  // Mirrors the checkpoint: once a resume is applied, LangGraph stops
  // reporting that interrupt, so recovery finds nothing pending afterwards.
  let reviewResumed = false;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => (reviewResumed ? null : {
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
    reviewResumed = true;
    return 'completed';
  };
  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    { petId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review.cancel',
    interactionId: 'review-current',
    decisionCount: 0,
  });

  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(
    handleChatCalls.length,
    1,
    'the cancelled review is gone from the checkpoint, so a late decision resolves nothing',
  );
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
  assert.equal(event.event?.code, 'review_closed');
});

test('handleReviewCancel recovers missing route from active checkpoint review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    { petId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    requestId: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review.cancel',
    interactionId: 'review-current',
    decisionCount: 0,
  });
});

test('handleReviewCancel interrupts an approve-only pending review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  let pendingInterrupt: unknown = {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    reviews: [{
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    }],
  };
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => pendingInterrupt,
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
    pendingInterrupt = null;
    return 'interrupted';
  };

  await handler.handleReviewCancel(
    fakePeer,
    {
      type: 'review.cancel',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
    },
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(sentEvents.length, 0);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        action: 'interrupt_run',
      },
    },
  });

  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'cancelled review route should be consumed');
});

test('handleHumanReviewResponse forwards canonical selected option without resolving it', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => ({
      sessionId: 'sess-active',
      interruptId: 'interrupt-1',
      reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Need input' },
        options: [{
          id: 'respond',
          label: 'Respond',
          input: { kind: 'text', key: 'message', required: true, multiline: true },
          decision: { type: 'respond', messageInputKey: 'message' },
        }],
      }],
    }),
  } as never;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current', 'respond', { message: '请先解释风险' }),
    { petId: 'pet-1' } as never,
  );

  assert.equal(sentEvents.length, 0);
  assert.equal(handleChatCalls.length, 1);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'respond',
          input: { message: '请先解释风险' },
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    interactionId: 'review-current',
    selectedOptionId: 'respond',
    decisionCount: 1,
  });
});

test('handleHumanReviewResponse rejects canonical review response from a different active session', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  let activeSessionId = 'sess-origin';
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => activeSessionId,
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => ({
      sessionId: 'sess-origin',
      interruptId: 'interrupt-1',
      reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }],
    }),
  } as never;
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  activeSessionId = 'sess-other';

  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /发起该 review 的会话/);
  assert.equal(event.event?.code, 'review_wrong_session');
});

test('handleHumanReviewResponse forwards effect-bearing options without local authorization side effects', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const updateStateCalls: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);

  const handler = new ServerChatHandler({
    graphService: {
      updateState: async (...args: unknown[]) => {
        updateStateCalls.push(args);
      },
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{
            id: 'approve-and-authorize-thread',
            label: 'Approve and authorize',
            decision: { type: 'approve' },
            effects: [{
              type: 'graph.authorize_tool_action',
              scope: 'thread',
            }],
          }],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current', 'approve-and-authorize-thread'),
    {
      petId: 'pet-1',
    } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(updateStateCalls.length, 0);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1] as {
    kind: string;
    resume?: unknown;
  };
  const forwardedSource = (handleChatCalls[0] as unknown[])[3];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      'interrupt-1': {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve-and-authorize-thread',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'human_review_response',
    interactionId: 'review-current',
    selectedOptionId: 'approve-and-authorize-thread',
    decisionCount: 1,
  });
  assert.equal(
    sentEvents.some((event) =>
      Boolean(event && typeof event === 'object' && (event as {
        event?: { type?: string };
      }).event?.type === 'system.notice'),
    ),
    false,
  );
});

test('handleHumanReviewResponse does not validate authorization effect context in transport', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const updateStateCalls: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);

  const handler = new ServerChatHandler({
    graphService: {
      updateState: async (...args: unknown[]) => {
        updateStateCalls.push(args);
      },
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{
            id: 'approve-and-authorize-thread',
            label: 'Approve and authorize',
            decision: { type: 'approve' },
            effects: [{
              type: 'graph.authorize_tool_action',
              scope: 'thread',
              actionRef: { type: 'pending_action' },
              matcher: { type: 'policy_hook' },
            }],
          }],
        }],
      }),
    } as never,
    inflightRequests: new InflightRequestController({
      emitOperation: () => {},
      sendControl: () => {},
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handler as any).runChatRequest = async (...args: unknown[]) => {
    handleChatCalls.push(args);
  };
  await handler.handleHumanReviewResponse(
    fakePeer,
    humanReviewResponse('review-current', 'approve-and-authorize-thread'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(updateStateCalls.length, 0);
  assert.equal(sentEvents.length, 0);
});

test('a review resolution that settles into a task pause is finalized as interrupted', async () => {
  const controls: unknown[] = [];
  const sent: unknown[] = [];
  const fakePeer = createFakePeer(sent);
  const handler = new ServerChatHandler({
    graphService: {} as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      refreshActiveSessionSummary: async () => {},
      readActivePendingInterrupt: async () => ({
        sessionId: 'sess-active',
        interruptId: 'interrupt-1',
        reviews: [{
          id: 'review-1',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }],
      }),
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests: new InflightRequestController<ServerPeer>({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => controls.push(message),
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async () => ({ status: 'paused' }),
  });

  await handler.handleReviewCancel(fakePeer, {
    type: 'review.cancel',
    requestId: 'req-1',
    interruptId: 'interrupt-1',
  }, { petId: 'pet-1' } as never);

  // The protocol has no pause outcome; the TUI derives the pause from the
  // snapshot that follows an interrupted run. Nothing aborted this run, and it
  // must still be finalized on the wire.
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), ['req-1']);
});
