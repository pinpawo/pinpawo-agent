import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHumanReviewRequest } from '@pinpawo/pet-agent';
import type { HumanReviewResponse, InterruptResumeMessage } from '@pinpawo/agent-session';
import { isToolProtocolHistoryError, ServerChatHandler } from './serverChatHandler';
import { InflightRequestController } from './inflightRequestController';
import type { ServerPeer } from './wire/peer';

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
  input?: HumanReviewResponse['input'],
  interruptId = 'interrupt-1',
): InterruptResumeMessage {
  return {
    type: 'interrupt.resume',
    requestId: 'req-1',
    interruptId,
    value: {
      decisions: [{
        interactionId,
        selectedOptionId,
        ...(input ? { input } : {}),
      }],
    },
  };
}

function reviewCancel(
  interruptId = 'interrupt-1',
  requestId = 'req-1',
): InterruptResumeMessage {
  return {
    type: 'interrupt.resume',
    requestId,
    interruptId,
    value: { action: 'cancel' },
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
    // The superseded run settles with nothing to continue, so it reports a
    // plain interruption.
    graphService: { settleAbortedRun: async () => null } as never,
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

test('run interrupt during a review resume neither supersedes nor resolves it', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }] },
      }),
      buildChatSetup: () => ({
        graphConfig: {},
        input: { messages: [] },
      }),
    } as never,
    inflightRequests,
    loadContext: async () => ({} as never),
    runAgentTurn: async () => {
      runCount += 1;
      // The review resume settles into a pending interrupt of its own.
      return { status: 'waiting' as const };
    },
  });
  const resolution = handler.handleInterruptResume(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );
  assert.equal(await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-1',
  }, { petId: 'pet-1' } as never), null);

  await resolution;

  // The resume ran once. The concurrent stop request started no second run and
  // resolved nothing: it only re-announced what the checkpoint holds.
  assert.equal(runCount, 1);
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), []);
});

test('run interrupt re-announces a review that became pending before the client observed it', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-race',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }] },
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
      return { status: 'waiting' };
    },
  });
  // The TUI chose run.interrupt from stale thinking state, but the active
  // checkpoint already holds the interrupt.

  const result = await handler.handleRunInterrupt(fakePeer, {
    type: 'run.interrupt',
    requestId: 'req-race',
  }, { petId: 'pet-1' } as never);

  assert.equal(result, null);
  // The Host resolves nothing on the person's behalf: a stop request is not a
  // review decision. It re-announces what is pending and the interface
  // reconciles to it.
  assert.deepEqual(requests, []);
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), []);
  const announced = sent.find((item) => (
    (item as { event?: { type?: string } }).event?.type === 'interrupt.requested'
  )) as { event?: { pendingInterrupt?: { interruptId?: string } } } | undefined;
  assert.equal(announced?.event?.pendingInterrupt?.interruptId, 'interrupt-race');
});

test('a review decision resume rejects a stale canonical interactionId before forwarding', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => ({
      sessionId: 'sess-active',
      interruptId: 'interrupt-1',
      payload: { kind: 'human_review', reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }] },
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
  await handler.handleInterruptResume(
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
  assert.equal(event.event?.code, 'interrupt_stale');
});

test('a review decision resume consumes matching canonical review route once', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  let pendingInterrupt: unknown = {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    payload: { kind: 'human_review', reviews: [{
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    }] },
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
  await handler.handleInterruptResume(fakePeer, message, { petId: 'pet-1' } as never);
  await handler.handleInterruptResume(fakePeer, message, { petId: 'pet-1' } as never);

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
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_decision',
    interactionId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
  assert.equal(sentEvents.length, 1, 'second response should be rejected after route is consumed');
  const event = sentEvents[0] as { type: string; event?: { type: string; message: string; code?: string } };
  assert.equal(event.type, 'event');
  assert.equal(event.event?.type, 'error');
  assert.match(event.event?.message ?? '', /已关闭|不存在/);
  assert.equal(event.event?.code, 'interrupt_closed');

  await handler.handleInterruptResume(
    fakePeer,
    reviewCancel('interrupt-1', 'req-1'),
    { petId: 'pet-1' } as never,
  );
  assert.equal((sentEvents.at(-1) as { event?: { code?: string } }).event?.code, 'interrupt_closed');
});

test('a review decision resume keeps single-review review as batch resume shape', async () => {
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
        payload: { kind: 'human_review', reviews: [review] },
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
  await handler.handleInterruptResume(
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
      interruptId: 'interrupt-1',
      value: {
        decisions: [{ reviewId: 'review-current', selectedOptionId: 'approve' }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_decision',
    interactionId: 'review-current',
    selectedOptionId: 'approve',
    decisionCount: 1,
  });
});

test('a review decision resume recovers missing route from active checkpoint review', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }] },
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

  await handler.handleInterruptResume(
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
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve',
        }],
      },
    },
  });
});

test('a review decision resume releases a recovered review when its peer disconnects', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }] },
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

  await handler.handleInterruptResume(fakePeer, message, { petId: 'pet-1' } as never);
  assert.equal(handleChatCalls.length, 0);

  connected = true;
  await handler.handleInterruptResume(fakePeer, message, { petId: 'pet-1' } as never);
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
    payload: { kind: 'human_review', reviews: [review] },
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

test('a review cancel resume resumes pending review with run interruption control', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }] },
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
  await handler.handleInterruptResume(
    fakePeer,
    reviewCancel('interrupt-1', 'req-1'),
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
      interruptId: 'interrupt-1',
      value: {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_cancel',
    interactionId: 'review-current',
    decisionCount: 0,
  });

  await handler.handleInterruptResume(
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
  assert.equal(event.event?.code, 'interrupt_closed');
});

test('a review cancel resume recovers missing route from active checkpoint review', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-current',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }] },
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

  await handler.handleInterruptResume(
    fakePeer,
    reviewCancel('interrupt-1', 'req-1'),
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
      interruptId: 'interrupt-1',
      value: {
        action: 'interrupt_run',
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_cancel',
    interactionId: 'review-current',
    decisionCount: 0,
  });
});

test('a review cancel resume interrupts an approve-only pending review', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  let pendingInterrupt: unknown = {
    sessionId: 'sess-active',
    interruptId: 'interrupt-1',
    payload: { kind: 'human_review', reviews: [{
      id: 'review-current',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    }] },
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

  await handler.handleInterruptResume(
    fakePeer,
    reviewCancel('interrupt-1', 'req-1'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(sentEvents.length, 0);
  const forwardedMessage = (handleChatCalls[0] as unknown[])[1];
  assert.deepEqual(forwardedMessage, {
    kind: 'resume',
    requestId: 'req-1',
    resume: {
      interruptId: 'interrupt-1',
      value: {
        action: 'interrupt_run',
      },
    },
  });

  await handler.handleInterruptResume(
    fakePeer,
    humanReviewResponse('review-current'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1, 'cancelled review route should be consumed');
});

test('a review decision resume forwards canonical selected option without resolving it', async () => {
  const handleChatCalls: unknown[] = [];
  const sentEvents: unknown[] = [];
  const fakePeer = createFakePeer(sentEvents);
  const tuiSessions = {
    getActiveSessionId: () => 'sess-active',
    getChatThreadId: () => 'thread-x',
    readActivePendingInterrupt: async () => ({
      sessionId: 'sess-active',
      interruptId: 'interrupt-1',
      payload: { kind: 'human_review', reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Need input' },
        options: [{
          id: 'respond',
          label: 'Respond',
          input: { kind: 'text', key: 'message', required: true, multiline: true },
          decision: { type: 'respond', messageInputKey: 'message' },
        }],
      }] },
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
  await handler.handleInterruptResume(
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
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'respond',
          input: { message: '请先解释风险' },
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_decision',
    interactionId: 'review-current',
    selectedOptionId: 'respond',
    decisionCount: 1,
  });
});

test('a review decision resume rejects canonical review response from a different active session', async () => {
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
      payload: { kind: 'human_review', reviews: [{
        id: 'review-current',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }] },
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

  await handler.handleInterruptResume(
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
  assert.equal(event.event?.code, 'interrupt_wrong_session');
});

test('a review decision resume forwards effect-bearing options without local authorization side effects', async () => {
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
        payload: { kind: 'human_review', reviews: [{
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
        }] },
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
  await handler.handleInterruptResume(
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
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          reviewId: 'review-current',
          selectedOptionId: 'approve-and-authorize-thread',
        }],
      },
    },
  });
  assert.deepEqual(forwardedSource, {
    type: 'review_decision',
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

test('a review decision resume does not validate authorization effect context in transport', async () => {
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
        payload: { kind: 'human_review', reviews: [{
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
        }] },
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
  await handler.handleInterruptResume(
    fakePeer,
    humanReviewResponse('review-current', 'approve-and-authorize-thread'),
    { petId: 'pet-1' } as never,
  );

  assert.equal(handleChatCalls.length, 1);
  assert.equal(updateStateCalls.length, 0);
  assert.equal(sentEvents.length, 0);
});

test('an aborted run that left work behind is finalized as a pause, not an interruption', async () => {
  const controls: unknown[] = [];
  const sent: unknown[] = [];
  const fakePeer = createFakePeer(sent);
  let settleCalls = 0;
  const handler = new ServerChatHandler({
    graphService: {
      settleAbortedRun: async () => {
        settleCalls += 1;
        return {
          interruptId: 'interrupt-pause',
          payload: { kind: 'pause_task' as const },
        };
      },
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      refreshActiveSessionSummary: async () => {},
      buildChatSetup: () => ({ graphKey: 'test', graphConfig: {}, input: { messages: [] } }),
    } as never,
    inflightRequests: new InflightRequestController<ServerPeer>({
      emitOperation: () => undefined,
      sendControl: (_peer, message) => controls.push(message),
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async () => ({ status: 'interrupted' as const }),
  });

  await handler.handleChatRequest(fakePeer, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'run something long',
  }, { actorId: 'pet-1' } as never);

  assert.equal(settleCalls, 1);
  // The cancelled run is continuable, so it is announced by id like any other
  // interrupt instead of reported as an interruption the person cannot resume.
  assert.deepEqual(interruptedRuns(sent), []);
  const announced = sent.find((item) => (
    (item as { event?: { type?: string } }).event?.type === 'interrupt.requested'
  )) as { event?: { pendingInterrupt?: { interruptId?: string; payload?: { kind?: string } } } } | undefined;
  assert.equal(announced?.event?.pendingInterrupt?.interruptId, 'interrupt-pause');
  assert.equal(announced?.event?.pendingInterrupt?.payload?.kind, 'pause_task');
});

test('an aborted run with nothing to continue still reports an interruption', async () => {
  const sent: unknown[] = [];
  const fakePeer = createFakePeer(sent);
  const handler = new ServerChatHandler({
    graphService: {
      settleAbortedRun: async () => null,
    } as never,
    tuiSessions: {
      getActiveSessionId: () => 'sess-active',
      getChatThreadId: () => 'thread-x',
      refreshActiveSessionSummary: async () => {},
      buildChatSetup: () => ({ graphKey: 'test', graphConfig: {}, input: { messages: [] } }),
    } as never,
    inflightRequests: new InflightRequestController<ServerPeer>({
      emitOperation: () => undefined,
      sendControl: () => undefined,
    }),
    loadContext: async () => ({} as never),
    runAgentTurn: async () => ({ status: 'interrupted' as const }),
  });

  await handler.handleChatRequest(fakePeer, {
    type: 'chat_request',
    requestId: 'req-1',
    message: 'answer briefly',
  }, { actorId: 'pet-1' } as never);

  assert.deepEqual(interruptedRuns(sent), ['req-1']);
  assert.equal(
    sent.some((item) => (item as { event?: { type?: string } }).event?.type === 'interrupt.requested'),
    false,
    'a run that merely ended must not claim a pause',
  );
});

test('a review resolution that settles into a task pause finalizes as waiting, not interrupted', async () => {
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
        payload: { kind: 'human_review', reviews: [{
          id: 'review-1',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
          ],
        }] },
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
    runAgentTurn: async () => ({ status: 'waiting' }),
  });

  await handler.handleInterruptResume(fakePeer, reviewCancel('interrupt-1', 'req-1'), { petId: 'pet-1' } as never);

  // The pause has an outcome of its own now: the adapter announced it by id
  // through interrupt.requested, so the run does not report an interruption
  // and the interface never has to infer a pause from a run ending.
  assert.deepEqual(controls, []);
  assert.deepEqual(interruptedRuns(sent), []);
});
