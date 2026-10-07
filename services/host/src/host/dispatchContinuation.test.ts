import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import type { TuiSessionPendingDispatch } from '../session/tuiSessionRegistry';
import type { PetDispatchLifecycleEvent } from './contracts';
import { continueSuspendedDispatch } from './dispatchContinuation';
import { readPetInvocationContext } from './petInvocationContext';

const review = (interruptId: string) => ({
  interruptId,
  payload: { kind: 'human_review', interactions: [] },
}) as never;

function harness(pendingAfterStop: string | null = null) {
  const session = {
    id: 'pet:00000001',
    threadId: 'thread-1',
    pendingDispatch: {
      interruptId: 'review-1', dispatchId: 'dispatch-1', request: 'do it',
      scope: { namespace: 'channel', id: 'ch-1' },
    } as TuiSessionPendingDispatch | undefined,
  };
  const events: PetDispatchLifecycleEvent[] = [];
  const contexts: unknown[] = [];
  const graph = {
    settle: async (): Promise<unknown> => pendingAfterStop ? { interruptId: pendingAfterStop, payload: { reviews: [] } } : null,
  };
  const sessions = {
    findSessionByThread: (_petId: string, threadId: string | undefined) => threadId === session.threadId ? session : null,
    setPendingDispatch: (_id: string, value: TuiSessionPendingDispatch | null) => {
      session.pendingDispatch = value ?? undefined;
    },
  };
  const turn = (interruptId: string) => ({
    request: { kind: 'resume', requestId: 'req-2', resume: { interruptId, value: {} } },
    setup: { input: { threadId: session.threadId } },
    graphService: {
      settleAbortedRun: () => graph.settle(),
      readThreadState: async () => ({ pendingInterrupt: null }),
    },
    emitEvent: () => {},
  }) as unknown as AgentSessionTurnOptions;
  const continueWith = (result: () => Promise<AgentSessionTurnResult>, emitted?: string) => continueSuspendedDispatch({
    petId: 'pet', sessions: sessions as never, publishLifecycle: (event) => events.push(event),
    run: async (options) => {
      contexts.push(readPetInvocationContext());
      if (emitted) options.emitEvent({ type: 'interrupt.requested', requestId: 'req-2', pendingInterrupt: review(emitted) });
      return result();
    },
  });
  return { session, events, contexts, graph, turn, continueWith };
}

test('a resume for another interrupt is an ordinary conversation turn', async () => {
  const h = harness();
  await h.continueWith(async () => ({ status: 'completed', reply: 'chat' }))(h.turn('other-review'));
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.contexts, [undefined]);
  assert.equal(h.session.pendingDispatch?.interruptId, 'review-1');
});

test('answering the recorded review continues the dispatch under its original identity', async () => {
  const h = harness();
  await h.continueWith(async () => ({ status: 'completed', reply: 'done' }))(h.turn('review-1'));
  assert.deepEqual(h.contexts, [{ petId: 'pet', dispatchId: 'dispatch-1', sessionId: 'pet:00000001', scope: { namespace: 'channel', id: 'ch-1' } }]);
  assert.deepEqual(h.events.map((event) => [event.state, event.dispatchId, event.scope?.id, event.reply]), [
    ['running', 'dispatch-1', 'ch-1', undefined],
    ['completed', 'dispatch-1', 'ch-1', 'done'],
  ]);
  assert.equal(h.session.pendingDispatch, undefined);
});

test('a continuation that stops on another review stays suspended on it', async () => {
  const h = harness();
  await h.continueWith(async () => ({ status: 'waiting' }), 'review-2')(h.turn('review-1'));
  assert.equal(h.events.at(-1)?.state, 'waiting');
  assert.equal(h.events.at(-1)?.pendingInterrupt?.interruptId, 'review-2');
  assert.equal(h.session.pendingDispatch?.interruptId, 'review-2');
  assert.equal(h.session.pendingDispatch?.dispatchId, 'dispatch-1');
});

test('a stop that leaves the review pending keeps the dispatch waiting', async () => {
  const h = harness('review-1');
  await h.continueWith(async () => ({ status: 'interrupted' }))(h.turn('review-1'));
  assert.equal(h.events.at(-1)?.state, 'waiting');
  assert.equal(h.session.pendingDispatch?.interruptId, 'review-1');
});

test('a stop with nothing pending interrupts the dispatch', async () => {
  const h = harness();
  await h.continueWith(async () => ({ status: 'interrupted' }))(h.turn('review-1'));
  assert.equal(h.events.at(-1)?.state, 'interrupted');
  assert.equal(h.session.pendingDispatch, undefined);
});

test('a failed continuation reports the original dispatch failed and rethrows', async () => {
  const h = harness();
  await assert.rejects(h.continueWith(async () => { throw new Error('model down'); })(h.turn('review-1')), /model down/);
  assert.deepEqual(h.events.map((event) => [event.state, event.error]), [['running', undefined], ['failed', 'model down']]);
  assert.equal(h.session.pendingDispatch, undefined);
});

test('a stop thrown as AbortError with nothing pending interrupts the dispatch', async () => {
  const h = harness();
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(h.continueWith(async () => { throw abort; })(h.turn('review-1')), /aborted/);
  assert.deepEqual(h.events.map((event) => event.state), ['running', 'interrupted']);
  assert.equal(h.session.pendingDispatch, undefined);
});

test('an unreadable outcome keeps the suspension so a retry still continues the dispatch', async () => {
  const h = harness();
  h.graph.settle = async () => { throw new Error('checkpoint unavailable'); };
  await assert.rejects(h.continueWith(async () => { throw new Error('state read failed'); })(h.turn('review-1')), /checkpoint unavailable/);
  await assert.rejects(h.continueWith(async () => ({ status: 'interrupted' }))(h.turn('review-1')), /checkpoint unavailable/);
  assert.deepEqual(h.events.map((event) => event.state), ['running', 'running']);
  assert.equal(h.session.pendingDispatch?.interruptId, 'review-1');

  h.graph.settle = async () => null;
  await h.continueWith(async () => ({ status: 'completed', reply: 'done' }))(h.turn('review-1'));
  assert.deepEqual(h.contexts.at(-1), { petId: 'pet', dispatchId: 'dispatch-1', sessionId: 'pet:00000001', scope: { namespace: 'channel', id: 'ch-1' } });
  assert.deepEqual([h.events.at(-1)?.state, h.events.at(-1)?.dispatchId, h.events.at(-1)?.scope?.id], ['completed', 'dispatch-1', 'ch-1']);
  assert.equal(h.session.pendingDispatch, undefined);
});

test('tool calls in the continued run report under the original dispatch', async () => {
  const h = harness();
  const settled = { type: 'tool_call.settled', requestId: 'req-2', messageId: 'm1', callId: 'c1', status: 'completed' } as const;
  await continueSuspendedDispatch({
    petId: 'pet', sessions: { findSessionByThread: () => h.session, setPendingDispatch: () => {} } as never,
    publishLifecycle: (event) => h.events.push(event),
    run: async (options) => { options.emitEvent(settled); return { status: 'completed', reply: 'done' }; },
  })({ ...h.turn('review-1'), emitEvent: () => {} } as never);
  assert.deepEqual(h.events.map((event) => [event.state, event.dispatchId, event.scope?.id, event.message?.type]), [
    ['running', 'dispatch-1', 'ch-1', undefined],
    ['message', 'dispatch-1', 'ch-1', 'tool_call.settled'],
    ['completed', 'dispatch-1', 'ch-1', undefined],
  ]);
});
