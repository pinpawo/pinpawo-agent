import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnOptions } from '../agent/chatSessionAdapter';
import type { HostTurnOutcome } from '../agent/serverChatHandler';
import { ensureActiveTuiSession, loadTuiSessionState, saveTuiSessionState, setTuiSessionPendingDispatch } from '../session/tuiSessionRegistry';
import type { PetDispatchLifecycleEvent } from './contracts';
import { attributeReviewDispatch } from './dispatchContinuation';
import { ResidentPetCoordinator } from './residentPetCoordinator';
import { readPetInvocationContext } from './petInvocationContext';

async function harness() {
  const file = join(await mkdtemp(join(tmpdir(), 'dispatch-prompt-')), 'sessions.json');
  const state = loadTuiSessionState(file);
  const original = ensureActiveTuiSession(state, 'pet', 'test-profile');
  setTuiSessionPendingDispatch(state, original.id, {
    interruptId: 'review-1', dispatchId: 'dispatch-1', request: 'do it',
    scope: { namespace: 'channel', id: 'ch-1' },
    systemPromptSections: [{ id: 'channel:collaboration', owner: 'channel', content: 'before restart' }],
    hint: { source: 'channel', instruction: 'original instruction', focus: 'original focus' },
  });
  saveTuiSessionState(state, file);
  const restored = loadTuiSessionState(file);
  const coordin = new ResidentPetCoordinator({ readSettledState: () => 'open' });
  const events: PetDispatchLifecycleEvent[] = [];
  const context: unknown[] = [];
  const bridge = attributeReviewDispatch({
    coordinator: coordin,
    petId: 'pet',
    sessions: { setPendingDispatch: (id, value) => setTuiSessionPendingDispatch(restored, id, value) },
    publishLifecycle: (event) => events.push(event),
    run: async (options) => {
      context.push([readPetInvocationContext(), options.setup.input.context]);
      options.emitEvent({ type: 'message.completed', requestId: 'req-2', messageId: 'm1', role: 'assistant', text: 'reply' });
      return { status: 'completed', reply: 'reply' };
    },
  });
  const getSession = () => restored.sessions[original.id]!;
  const deliver = (outcome: HostTurnOutcome, interruptId = 'review-1') => {
    const session = getSession();
    const request = { kind: 'resume' as const, requestId: 'req-2', resume: { interruptId, value: {} } };
    return bridge(session, request, async (runner) => {
      await runner?.({
        request,
        setup: { input: { threadId: session.threadId, context: { systemPromptSections: [{ id: 'pet:document', content: 'pet identity' }] } } },
        emitEvent: () => {},
      } as unknown as AgentSessionTurnOptions);
      return outcome;
    });
  };
  return { deliver, events, context, getSession };
}

test('attributes a validated resume using the original invocation context after restart', async () => {
  const h = await harness();
  await h.deliver({ outcome: 'completed', reply: 'reply', pendingInterrupt: null });
  const answer = h.events[0]?.dispatchId;
  assert.ok(answer && answer !== 'dispatch-1' && answer !== 'req-2');
  assert.ok(h.events.every(event => event.dispatchId === answer && event.resumesDispatchId === 'dispatch-1'));
  assert.deepEqual(h.events.map(event => event.state), ['running', 'message', 'completed']);
  assert.equal(h.events.at(-1)?.reply, 'reply');
  assert.equal(h.getSession().pendingDispatch, undefined);
  assert.deepEqual(h.context, [[
    { petId: 'pet', dispatchId: answer, sessionId: h.getSession().id, scope: { namespace: 'channel', id: 'ch-1' } },
    {
      systemPromptSections: [
        { id: 'pet:document', content: 'pet identity' },
        { id: 'channel:collaboration', owner: 'channel', content: 'before restart' },
      ],
      hint: { source: 'channel', instruction: 'original instruction', focus: 'original focus' },
    },
  ]]);
});

test('a non-dispatched review resumes without creating a Dispatch', async () => {
  const h = await harness();
  const result = { outcome: 'completed' } as const;
  assert.equal(await h.deliver(result, 'other'), result);
  assert.deepEqual(h.events, []);
  assert.equal(h.getSession().pendingDispatch?.dispatchId, 'dispatch-1');
});

test('waiting links the next approval to the answer Dispatch; failure stays failure', async () => {
  const h = await harness();
  const firstPending = { interruptId: 'review-1', payload: { kind: 'human_review' as const, interactions: [] } };
  const timeout = new DOMException('provider timed out', 'TimeoutError');
  await h.deliver({ outcome: 'failed', error: timeout, pendingInterrupt: firstPending });
  assert.equal(h.events.at(-1)?.state, 'failed');
  assert.equal(h.events.at(-1)?.error, 'provider timed out');
  assert.equal(h.getSession().pendingDispatch?.dispatchId, 'dispatch-1');
  await h.deliver({ outcome: 'failed', error: new Error('unconfirmed') });
  assert.equal(h.getSession().pendingDispatch?.dispatchId, 'dispatch-1');
  const nextPending = { ...firstPending, interruptId: 'review-2' };
  await h.deliver({ outcome: 'waiting', pendingInterrupt: nextPending });
  const answer = h.events.at(-1)!.dispatchId;
  assert.equal(h.events.at(-1)?.state, 'waiting');
  assert.equal(h.getSession().pendingDispatch?.dispatchId, answer);
  assert.equal(h.getSession().pendingDispatch?.interruptId, nextPending.interruptId);
  await h.deliver({ outcome: 'interrupted', pendingInterrupt: null }, 'review-2');
  assert.equal(h.events.at(-1)?.resumesDispatchId, answer);
  assert.equal(h.events.at(-1)?.state, 'interrupted');
  assert.equal(h.getSession().pendingDispatch, undefined);
});
