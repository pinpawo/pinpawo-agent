import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReviewSpec } from '@pinpawo/pet-agent';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import { createResidentPetRuntime, type CreateResidentPetRuntimeOptions } from '../residentPetHost';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import { FileSaver } from '../fileSaver';
import { createResidentPet } from './residentPetDispatch';
import { createResidentPetInteraction } from './residentPetInteraction';
import { createResidentPetSessions } from './residentPetSessions';
import { readResidentPetRuntimeContext } from './runtimeContext';
import { readPetInvocationContext } from './petInvocationContext';
import { PetDispatchRefusedError, type PetDispatchLifecycleEvent } from './contracts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected Host state was not reached.');
}

const sessionId = 'worker:00000001';
const scope = { namespace: 'channel', id: 'one' };
const target = { session: { id: sessionId, create: true }, scope };
const head = { ...target, delivery: 'idle-only' as const, request: 'Head input',
  dispatchId: 'head', origin: { namespace: 'channel', id: 'source-message' } };

test('cancellation during context resolution prevents admission', async () => {
  const entered = deferred(), release = deferred();
  let turns = 0;
  const h = await fixture(async turn => { turns++; return reply(turn, 'unexpected'); }, {
    resolveInvocationContext: async () => { entered.resolve(); await release.promise; return []; },
  });
  try {
    const controller = new AbortController();
    const admission = h.resident.dispatch.dispatch({ ...target, request: 'cancelled', signal: controller.signal });
    await entered.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(admission, { name: 'AbortError' });
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.equal(turns, 0);
    assert.deepEqual(h.events, []);
  } finally { release.resolve(); await h.close(); }
});

test('idle-only dispatch does not join or interrupt a scheduler dispatch admitted during context resolution', async () => {
  const preparing = deferred(), releaseContext = deferred(), started = deferred(), finish = deferred();
  let workSignal!: AbortSignal;
  const h = await fixture(async turn => {
    const text = turn.request.kind === 'user_message' ? turn.request.message : '';
    assert.equal(text, 'scheduled');
    workSignal = turn.setup.input.signal!;
    started.resolve();
    await finish.promise;
    workSignal.throwIfAborted();
    return reply(turn, text);
  }, { resolveInvocationContext: async ({ request }) => {
    if (request === head.request) { preparing.resolve(); await releaseContext.promise; }
    return undefined;
  } });
  try {
    const admission = h.resident.dispatch.dispatch(head);
    await preparing.promise;
    assert.equal(h.resident.dispatch.getQueueSnapshot().state, 'open');
    await h.resident.dispatch.dispatch({ ...target, request: 'scheduled', dispatchId: 'scheduler' });
    await started.promise;
    releaseContext.resolve();
    await assert.rejects(admission, PetDispatchRefusedError);
    const snapshot = h.resident.dispatch.getQueueSnapshot();
    assert.equal(snapshot.activeDispatch?.dispatchId, 'scheduler');
    assert.equal(snapshot.queuedDispatches, 0);
    assert.equal(workSignal.aborted, false);
    finish.resolve();
    await waitFor(() => h.resident.dispatch.getQueueSnapshot().activeOperation === null);
    assert.ok(h.events.every(event => event.dispatchId === 'scheduler'));
  } finally { releaseContext.resolve(); finish.resolve(); await h.close(); }
});

test('idle-only dispatch cannot use readiness read across a conversation that already settled', async () => {
  const reading = deferred(), releaseRead = deferred();
  let holdRead = false;
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    turns.push(turn.request.message);
    return reply(turn, 'done');
  }, { beforeReadState: async () => {
    if (!holdRead) return;
    holdRead = false;
    reading.resolve();
    await releaseRead.promise;
  } });
  try {
    holdRead = true;
    const admission = h.resident.dispatch.dispatch(head);
    await reading.promise;
    // TUI owns this same resident gate for a conversation. Even if it has
    // finished by the time the target read returns, that read must not win.
    await h.interaction.request({ type: 'chat_request', requestId: 'tui', message: 'TUI conversation' });
    assert.equal(h.resident.dispatch.getQueueSnapshot().state, 'open');
    releaseRead.resolve();
    await assert.rejects(admission, PetDispatchRefusedError);
    assert.deepEqual(turns, ['TUI conversation']);
    assert.deepEqual(h.events, []);
  } finally { releaseRead.resolve(); await h.close(); }
});

test('idle-only dispatch refuses the bound session waiting for review even while the interactive session is idle', async () => {
  const h = await fixture(async turn => reply(turn, 'done'));
  try {
    const session = h.context.sessions.ensureDispatchSession('worker', sessionId, true);
    assert.notEqual(h.context.sessions.getActiveSession('worker').id, session.id);
    h.reviews.set(session.threadId, buildReviewSpec({ id: 'approval',
      view: { kind: 'plain', body: 'Approve this operation?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
    }));
    const dispatch = h.resident.dispatch;
    assert.equal(await h.context.coordinator.refreshState(), 'open');
    await assert.rejects(dispatch.dispatch(head), PetDispatchRefusedError);
    assert.equal(dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.equal(h.events.length, 0);
    assert.equal((await h.sessions.snapshot(sessionId)).session.pendingInterrupt?.interruptId, 'review-interrupt');
    // Ordinary producers still queue for the same target and run after review.
    await dispatch.dispatch({ ...target, request: 'scheduled', dispatchId: 'scheduler' });
    assert.equal(dispatch.getQueueSnapshot().queuedDispatches, 1);
    assert.deepEqual(h.events.map(event => [event.dispatchId, event.state]), [['scheduler', 'queued']]);
    await waitFor(() => dispatch.getQueueSnapshot().state === 'waiting');
    h.reviews.delete(session.threadId);
    await h.context.coordinator.refreshState();
    await waitFor(() => dispatch.getQueueSnapshot().activeOperation === null && dispatch.getQueueSnapshot().queuedDispatches === 0);

    await dispatch.dispatch(head);
    assert.equal(dispatch.getQueueSnapshot().queuedDispatches, 0);
    await waitFor(() => h.events.some(event => event.dispatchId === 'head' && event.state === 'completed'));
    assert.deepEqual(h.events.filter(event => event.dispatchId === 'head').map(event => [event.state, event.sessionId]),
      [['queued', sessionId], ['running', sessionId], ['message', sessionId], ['completed', sessionId]]);
  } finally { await h.close(); }
});

async function fixture(run: (turn: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>, hooks: {
  beforeContextLoad?: () => Promise<void>;
  beforeReadState?: (threadId: string) => Promise<void>;
  resolveInvocationContext?: CreateResidentPetRuntimeOptions['resolveInvocationContext'];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pet-incoming-'));
  const runtimeConfig = buildHostRuntimeConfig(directory);
  const reviews = new Map<string, ReturnType<typeof buildReviewSpec>>();
  const pending = (threadId: string) => reviews.has(threadId) ? {
    interruptId: 'review-interrupt', payload: { kind: 'human_review' as const, reviews: [reviews.get(threadId)!] },
  } : null;
  const runtime = await createResidentPetRuntime({
    petId: 'worker', petName: 'Worker', runtimeConfig,
    modelProfiles: createTestModelProfiles(), capabilities: [],
    toolkitInventory: new HostToolkitInventoryStore(),
    checkpointer: new FileSaver(runtimeConfig.checkpointPath),
    sessionStatePath: runtimeConfig.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    loadContext: async () => { await hooks.beforeContextLoad?.(); return { pet: { id: 'worker', name: 'Worker' } }; },
    resolveInvocationContext: hooks.resolveInvocationContext ?? (async ({ scope }) => [{ id: 'domain', owner: scope.namespace, content: scope.id }]),
    graphService: {
      readThreadState: async ({ input }: AgentSessionTurnOptions['setup']) => {
        await hooks.beforeReadState?.(input.threadId!);
        return { messages: [], pendingInterrupt: pending(input.threadId!), acceptsResume: reviews.has(input.threadId!), currentPlan: null };
      },
      settleAbortedRun: async ({ input }: AgentSessionTurnOptions['setup']) => pending(input.threadId!),
    } as never,
    runAgentTurn: run,
  });
  const resident = createResidentPet(runtime);
  const context = readResidentPetRuntimeContext(runtime);
  const events: PetDispatchLifecycleEvent[] = [];
  resident.dispatch.onDispatchLifecycle(event => events.push(event));
  return {
    resident, context, events, reviews,
    interaction: createResidentPetInteraction(runtime), sessions: createResidentPetSessions(runtime),
    close: async () => { await resident.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function reply(turn: AgentSessionTurnOptions, text: string): AgentSessionTurnResult {
  turn.emitEvent({ type: 'message.completed', requestId: turn.request.requestId,
    messageId: `reply:${turn.request.requestId}`, role: 'assistant', text });
  return { status: 'completed', reply: text };
}

test('ordinary same-session queued input waits through delegation completion and retains attribution', async () => {
  const started = deferred(), delivered = deferred();
  const turns: Array<{ message: string; invocation: ReturnType<typeof readPetInvocationContext> }> = [];
  const incoming = JSON.stringify({ type: 'channel_message', author: { kind: 'pet', participantId: 'pet:reviewer' }, body: 'Delivery ready' });
  let firstSignal!: AbortSignal;
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const message = turn.request.kind === 'user_message' ? turn.request.message : '';
    turns.push({ message, invocation: readPetInvocationContext() });
    if (message === 'first') {
      firstSignal = turn.setup.input.signal!;
      started.resolve();
      await delivered.promise;
      await turn.setup.input.onDelegationComplete?.();
      firstSignal.throwIfAborted();
      assert.equal(firstSignal.aborted, false, 'queued input cannot preempt accepted work at a boundary');
    }
    return reply(turn, message);
  });
  try {
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'first', request: 'first' });
    await started.promise;
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'next', request: incoming });
    assert.equal(firstSignal.aborted, false, 'ordinary dispatch does not interrupt');
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    delivered.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'next' && event.state === 'completed'));
    assert.deepEqual(turns.map(turn => turn.message), ['first', incoming]);
    assert.deepEqual(turns.map(turn => turn.invocation?.dispatchId), ['first', 'next']);
    assert.ok(h.events.some(event => event.dispatchId === 'first' && event.state === 'completed'));
    assert.ok(!h.events.some(event => event.state === 'interrupted'));
    assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => [event.dispatchId, event.message?.text]), [['first', 'first'], ['next', incoming]]);
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
  } finally { delivered.resolve(); await h.close(); }
});

test('immediate input during setup interrupts the admitted request without cancelling its successor', async () => {
  const preparing = deferred(), releaseSetup = deferred();
  let blockSetup = false;
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const text = turn.request.kind === 'user_message' ? turn.request.message : '';
    turns.push(text);
    return reply(turn, text);
  }, { beforeContextLoad: async () => {
    if (!blockSetup) return;
    blockSetup = false;
    preparing.resolve(); await releaseSetup.promise;
  } });
  h.resident.dispatch.onDispatchLifecycle(event => {
    if (event.dispatchId === 'first' && event.state === 'running') blockSetup = true;
  });
  try {
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'first', request: 'first' });
    await preparing.promise;
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'next', request: 'next', delivery: 'interrupt' });
    releaseSetup.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'next' && event.state === 'completed'));
    assert.deepEqual(turns, ['next']);
    assert.deepEqual(h.events.filter(event => event.state === 'interrupted').map(event => event.dispatchId), ['first']);
  } finally { releaseSetup.resolve(); await h.close(); }
});

test('immediate input during review settlement cannot cancel a later human approval', async () => {
  const settling = deferred(), releaseSettlement = deferred();
  let blockRead = false;
  let resumed = false;
  let h!: Awaited<ReturnType<typeof fixture>>;
  h = await fixture(async turn => {
    if (turn.request.kind === 'resume') {
      assert.equal(turn.setup.input.signal?.aborted, false);
      resumed = true;
      h.reviews.delete(turn.setup.input.threadId!);
      return reply(turn, 'approved');
    }
    if (turn.request.message === 'first') {
      h.reviews.set(turn.setup.input.threadId!, buildReviewSpec({ id: 'approval',
        view: { kind: 'plain', body: 'Approve this operation?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }));
      blockRead = true;
      return { status: 'waiting' };
    }
    return reply(turn, turn.request.message);
  }, { beforeReadState: async () => {
    if (!blockRead) return;
    blockRead = false;
    settling.resolve(); await releaseSettlement.promise;
  } });
  try {
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'first', request: 'first' });
    await settling.promise;
    assert.equal(h.resident.dispatch.getQueueSnapshot().activeDispatch?.dispatchId, 'first');
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'next', request: 'next', delivery: 'interrupt' });
    releaseSettlement.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'first' && event.state === 'waiting'));
    await waitFor(() => h.context.activeRuns.read() === null);
    await h.sessions.review(sessionId, { requestId: 'human-approval', interruptId: 'review-interrupt',
      value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });
    await waitFor(() => resumed);
    assert.equal(resumed, true, 'the incoming input must not leave a cancellation flag for the review resume');
    await waitFor(() => h.events.some(event => event.dispatchId === 'next' && event.state === 'completed'));
    assert.equal(h.context.sessions.getSession('worker', sessionId)?.pendingDispatch, undefined);
    assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => event.dispatchId), ['first', 'next']);
  } finally { releaseSettlement.resolve(); await h.close(); }
});

test('ordinary queued input preserves admission FIFO across sessions and scopes', async () => {
  const started = deferred(), boundary = deferred();
  const turns: string[] = [];
  const h = await fixture(async turn => {
    const text = turn.request.kind === 'user_message' ? turn.request.message : '';
    turns.push(text);
    if (text === 'first') {
      started.resolve(); await boundary.promise;
      await turn.setup.input.onDelegationComplete?.();
      turn.setup.input.signal?.throwIfAborted();
    }
    return reply(turn, text);
  });
  try {
    await h.resident.dispatch.dispatch({ ...target, request: 'first' });
    await started.promise;
    await h.resident.dispatch.dispatch({ session: { id: 'worker:00000002', create: true }, scope, request: 'other-session' });
    await h.resident.dispatch.dispatch({ ...target, scope: { namespace: 'other-plugin', id: scope.id }, request: 'other-namespace' });
    await h.resident.dispatch.dispatch({ ...target, scope: { ...scope, id: 'two' }, request: 'other-channel' });
    await h.resident.dispatch.dispatch({ ...target, scope: undefined, request: 'unscoped' });
    await h.resident.dispatch.dispatch({ scope, request: 'implicit-session' });
    await h.resident.dispatch.dispatch({ ...target, request: 'next-1' });
    await h.resident.dispatch.dispatch({ ...target, request: 'next-2' });
    boundary.resolve();
    await waitFor(() => h.events.filter(event => event.state === 'completed').length === 8);
    assert.deepEqual(turns, ['first', 'other-session', 'other-namespace', 'other-channel', 'unscoped', 'implicit-session', 'next-1', 'next-2']);
  } finally { boundary.resolve(); await h.close(); }
});

test('explicit interrupt is immediate only for the same scoped session', async () => {
  const started = deferred();
  const turns: string[] = [];
  let activeSignal!: AbortSignal;
  const h = await fixture(async turn => {
    const text = turn.request.kind === 'user_message' ? turn.request.message : '';
    turns.push(text);
    if (text === 'first') {
      activeSignal = turn.setup.input.signal!; started.resolve();
      await new Promise<void>(resolve => activeSignal.addEventListener('abort', () => resolve(), { once: true }));
      activeSignal.throwIfAborted();
    }
    return reply(turn, text);
  });
  try {
    await assert.rejects(h.resident.dispatch.dispatch({ request: 'invalid', delivery: 'interrupt' }), /explicit session and scope/);
    await assert.rejects(h.resident.dispatch.dispatch({ ...target, request: 'invalid', delivery: 'bad' as 'interrupt' }), /Unsupported/);
    await h.resident.dispatch.dispatch({ ...target, request: 'first', dispatchId: 'first' });
    await started.promise;
    for (const other of [
      { session: { id: 'worker:00000002', create: true }, scope },
      { session: target.session, scope: { ...scope, namespace: 'another' } },
      { session: target.session, scope: { ...scope, id: 'another' } },
    ]) {
      await h.resident.dispatch.dispatch({ ...other, request: JSON.stringify(other), delivery: 'interrupt' });
      assert.equal(activeSignal.aborted, false);
    }
    await h.resident.dispatch.dispatch({ ...target, request: 'earlier' });
    await h.resident.dispatch.dispatch({ ...target, request: 'urgent', delivery: 'interrupt' });
    assert.equal(activeSignal.aborted, true);
    await waitFor(() => h.events.filter(event => event.state === 'completed').length === 5);
    assert.deepEqual(turns.slice(0, 2), ['first', 'earlier']);
    assert.equal(turns.filter(text => text === 'urgent').length, 1);
    assert.equal(h.events.filter(event => event.state === 'interrupted').length, 1, 'the urgent input cannot abort a later turn');
  } finally {
    if (h.context.activeRuns.read()) h.context.localHandlers.interruptRun(h.context.activeRuns.read()!.requestId);
    await h.close();
  }
});

test('an immediate interruption that races with native review preserves approval and queued input', async () => {
  const started = deferred(), resumeStarted = deferred(), resumeBoundary = deferred();
  let resumed = false;
  let h!: Awaited<ReturnType<typeof fixture>>;
  h = await fixture(async turn => {
    if (turn.request.kind === 'resume') {
      resumed = true;
      assert.equal(readPetInvocationContext()?.dispatchId, 'first');
      assert.equal(turn.setup.input.context?.systemPromptSections?.find(section => section.id === 'domain')?.content, scope.id);
      h.reviews.delete(turn.setup.input.threadId!);
      resumeStarted.resolve(); await resumeBoundary.promise;
      await turn.setup.input.onDelegationComplete?.();
      turn.setup.input.signal?.throwIfAborted();
      return reply(turn, 'approved work completed');
    }
    if (turn.request.message === 'first') {
      const signal = turn.setup.input.signal!;
      started.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      h.reviews.set(turn.setup.input.threadId!, buildReviewSpec({ id: 'approval',
        view: { kind: 'plain', body: 'Approve this operation?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }));
      signal.throwIfAborted();
    }
    return reply(turn, turn.request.message);
  });
  try {
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'first', request: 'first' });
    await started.promise;
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'next', request: 'next', delivery: 'interrupt' });
    await waitFor(() => h.events.some(event => event.dispatchId === 'first' && event.state === 'waiting'));
    assert.equal(resumed, false);
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    assert.equal(h.context.sessions.getSession('worker', sessionId)?.pendingDispatch?.interruptId, 'review-interrupt');
    assert.ok(!h.events.some(event => event.dispatchId === 'next' && event.state === 'running'));
    await waitFor(() => h.context.activeRuns.read() === null);
    await h.sessions.review(sessionId, { requestId: 'human-approval', interruptId: 'review-interrupt',
      value: { decisions: [{ interactionId: 'approval', selectedOptionId: 'approve' }] } });
    await resumeStarted.promise;
    resumeBoundary.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'next' && event.state === 'completed'));
    assert.equal(h.context.sessions.getSession('worker', sessionId)?.pendingDispatch, undefined);
    assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => event.dispatchId), ['first', 'next']);
  } finally { resumeBoundary.resolve(); await h.close(); }
});


test('queued dispatches retain separate request and hint snapshots across scopes and an unscoped next run', async () => {
  const started = deferred(), release = deferred();
  const first = { source: 'domain', instruction: 'first instruction', focus: 'first focus' };
  const second = { source: 'domain', instruction: 'second instruction', focus: 'second focus' };
  const seen: Array<{ message: string; hint: unknown; sections: unknown }> = [];
  const targets: unknown[] = [];
  const h = await fixture(async turn => {
    const message = turn.request.kind === 'user_message' ? turn.request.message : '';
    seen.push({ message, hint: turn.setup.input.context?.hint,
      sections: turn.setup.input.context?.systemPromptSections?.filter(section => section.id === 'domain') });
    if (message === 'first request') { started.resolve(); await release.promise; }
    return reply(turn, 'done');
  }, { resolveInvocationContext: async target => {
    targets.push(target);
    return { systemPromptSections: [{ id: 'domain', content: target.scope.id }],
      hint: target.request === 'first request' ? first : second };
  } });
  try {
    await h.resident.dispatch.dispatch({ ...target, request: 'first request', dispatchId: 'first' });
    await started.promise;
    const other = { request: 'second request', dispatchId: 'second', session: { id: 'worker:00000002', create: true },
      scope: { namespace: 'domain', id: 'two' } };
    await h.resident.dispatch.dispatch(other);
    other.request = 'mutated request';
    other.scope.id = 'mutated scope';
    first.focus = 'first changed'; second.instruction = 'second changed'; second.focus = 'second changed';
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    release.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'second' && event.state === 'completed'));
    await h.resident.dispatch.dispatch({ request: 'plain request', dispatchId: 'plain', session: { id: sessionId } });
    await waitFor(() => h.events.some(event => event.dispatchId === 'plain' && event.state === 'completed'));
    assert.deepEqual(seen.map(turn => [turn.message, turn.hint]), [
      ['first request', { source: 'domain', instruction: 'first instruction', focus: 'first focus' }],
      ['second request', { source: 'domain', instruction: 'second instruction', focus: 'second focus' }],
      ['plain request', undefined],
    ]);
    assert.deepEqual(seen.map(turn => turn.sections), [[{ id: 'domain', content: 'one' }], [{ id: 'domain', content: 'two' }], []]);
    assert.deepEqual(targets, [
      { petId: 'worker', sessionId, scope, request: 'first request' },
      { petId: 'worker', sessionId: 'worker:00000002', scope: { namespace: 'domain', id: 'two' }, request: 'second request' },
    ]);
    assert.ok(targets.every(target => Object.isFrozen(target)));
    assert.equal(targets.length, 2, 'plain input does not resolve scoped provider context');
  } finally { release.resolve(); await h.close(); }
});

test('explicit interruption is retained on either side of a delegation boundary', async () => {
  for (const timing of ['before', 'after'] as const) {
    const boundary = deferred(), release = deferred();
    let signal!: AbortSignal;
    const h = await fixture(async turn => {
      const text = turn.request.kind === 'user_message' ? turn.request.message : '';
      if (text === 'first') {
        signal = turn.setup.input.signal!;
        if (timing === 'after') await turn.setup.input.onDelegationComplete?.();
        boundary.resolve();
        await release.promise;
        if (timing === 'before') await turn.setup.input.onDelegationComplete?.();
        signal.throwIfAborted();
        assert.fail('Explicit interruption must stop the accepted current turn.');
      }
      return reply(turn, text);
    });
    try {
      await h.resident.dispatch.dispatch({ ...target, request: 'first', dispatchId: 'first' });
      await boundary.promise;
      await h.resident.dispatch.dispatch({ ...target, request: 'urgent', dispatchId: 'urgent', delivery: 'interrupt' });
      assert.equal(signal.aborted, true);
      release.resolve();
      await waitFor(() => h.events.some(event => event.dispatchId === 'urgent' && event.state === 'completed'));
      assert.equal(h.events.filter(event => event.dispatchId === 'first' && event.state === 'interrupted').length, 1);
      assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => event.dispatchId), ['urgent']);
    } finally { release.resolve(); await h.close(); }
  }
});

test('standalone stop holds the dispatch slot until Agent settlement; a late stop leaves the successor alone', async () => {
  const started = deferred(), release = deferred(), nextStarted = deferred(), releaseNext = deferred();
  const turns: string[] = [];
  let signal!: AbortSignal;
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const text = turn.request.message;
    turns.push(text);
    if (text === 'A') {
      signal = turn.setup.input.signal!;
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
    } else {
      signal = turn.setup.input.signal!;
      nextStarted.resolve();
      await releaseNext.promise;
    }
    return reply(turn, text);
  });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    await assert.rejects(service.dispatch({ ...target, request: 'duplicate A', dispatchId: 'a' }), /already been admitted/);
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    const stop = service.getQueueSnapshot().activeDispatch!.dispatchId;
    assert.equal(service.stop(stop), true);
    assert.equal(signal.aborted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(turns, ['A']);
    assert.equal(service.getQueueSnapshot().activeDispatch?.dispatchId, 'a');
    release.resolve();
    await nextStarted.promise;
    assert.equal(service.getQueueSnapshot().activeDispatch?.dispatchId, 'b');
    await assert.rejects(service.dispatch({ ...target, request: 'duplicate A after settlement', dispatchId: 'a' }), /already been admitted/);
    assert.equal(service.stop(stop), false);
    assert.equal(signal.aborted, false);
    assert.deepEqual(turns, ['A', 'B']);
    assert.ok(h.events.some(event => event.dispatchId === 'a' && event.state === 'interrupted'));
  } finally { release.resolve(); releaseNext.resolve(); await h.close(); }
});

test('stop fences queue writes before cancellation and until Host confirmation', async () => {
  const started = deferred(), exit = deferred(), confirming = deferred(), confirm = deferred();
  const resolving = deferred(), resolveInput = deferred();
  const turns: string[] = [];
  let signal!: AbortSignal;
  let holdConfirmation = false;
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    turns.push(turn.request.message);
    if (turn.request.message === 'A') {
      signal = turn.setup.input.signal!;
      started.resolve();
      await exit.promise;
      signal.throwIfAborted();
    }
    return reply(turn, 'done');
  }, {
    beforeReadState: async () => {
      if (!holdConfirmation) return;
      holdConfirmation = false;
      confirming.resolve();
      await confirm.promise;
    },
    resolveInvocationContext: async ({ request }) => {
      if (request === 'R') { resolving.resolve(); await resolveInput.promise; }
      return [];
    },
  });
  try {
    const service = h.resident.dispatch;
    const rejected = { name: 'PetDispatchRefusedError', message: /stopping/ };
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    const r = { ...target, request: 'R', dispatchId: 'r' };
    const inFlightWrite = service.dispatch(r);
    const checkInFlight = assert.rejects(inFlightWrite, rejected);
    await resolving.promise;
    let checkFromAbort: Promise<void> | undefined;
    signal.addEventListener('abort', () => {
      checkFromAbort = assert.rejects(
        service.dispatch({ ...target, request: 'from abort', dispatchId: 'sync' }), rejected);
    }, { once: true });
    let terminalStop: boolean | undefined;
    service.onDispatchLifecycle(event => {
      if (event.dispatchId === 'a' && event.state === 'interrupted') {
        terminalStop = service.stop('a');
        holdConfirmation = true;
      }
    });

    assert.equal(service.stop('a'), true);
    assert.ok(checkFromAbort);
    await checkFromAbort;
    resolveInput.resolve();
    await checkInFlight;
    await assert.rejects(service.supersede({ ...target, request: 'D', dispatchId: 'd' },
      { pendingDispatchIds: ['b'] }), rejected);
    await assert.rejects(service.dispatch({ ...head, dispatchId: 'idle' }), rejected);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['b']);
    exit.resolve();
    await confirming.promise;
    assert.equal(terminalStop, false);
    assert.equal(service.getQueueSnapshot().activeDispatch?.dispatchId, 'a');
    await assert.rejects(service.dispatch({ ...target, request: 'during confirmation', dispatchId: 'sync' }), rejected);
    assert.deepEqual(turns, ['A']);
    confirm.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'b' && event.state === 'completed'));
    await service.dispatch(r); // Failed admissions did not reserve the ID.
    await waitFor(() => h.events.some(event => event.dispatchId === 'r' && event.state === 'completed'));
    assert.deepEqual(turns, ['A', 'B', 'R']);
  } finally { resolveInput.resolve(); exit.resolve(); confirm.resolve(); await h.close(); }
});

test('failed stop confirmation keeps the queue fenced until a successful refresh', async () => {
  const started = deferred(), exit = deferred();
  const turns: string[] = [];
  let failRead = false;
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    turns.push(turn.request.message);
    if (turn.request.message === 'A') {
      started.resolve();
      await exit.promise;
      turn.setup.input.signal!.throwIfAborted();
    }
    return reply(turn, 'done');
  }, { beforeReadState: async () => { if (failRead) throw new Error('confirmation unavailable'); } });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    service.onDispatchLifecycle(event => {
      if (event.dispatchId === 'a' && event.state === 'interrupted') failRead = true;
    });
    assert.equal(service.stop('a'), true);
    exit.resolve();
    await waitFor(() => service.getQueueSnapshot().state === 'blocked' &&
      service.getQueueSnapshot().activeOperation === null);
    assert.deepEqual(turns, ['A']);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['b']);
    await assert.rejects(service.dispatch({ ...target, request: 'C', dispatchId: 'c' }), /stopping/);
    await assert.rejects(h.context.coordinator.refreshState(), /confirmation unavailable/);
    failRead = false;
    await h.context.coordinator.refreshState();
    await waitFor(() => h.events.some(event => event.dispatchId === 'b' && event.state === 'completed'));
    assert.deepEqual(turns, ['A', 'B']);
  } finally { exit.resolve(); await h.close(); }
});

test('supersede of a missing Session cannot create a Session or admit work', async () => {
  const h = await fixture(async turn => reply(turn, 'unexpected'));
  const id = 'worker:000000ff';
  // Simulate an older caller carrying ordinary dispatch's create flag.
  const session = { id, create: true };
  try {
    await assert.rejects(h.resident.dispatch.supersede({ request: 'D', scope, session },
      { pendingDispatchIds: ['stale'] }), /target Session does not exist/);
    assert.equal(h.context.sessions.getSession('worker', id), null);
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.deepEqual(h.events, []);
  } finally { await h.close(); }
});

test('standalone stop can cancel a selected Dispatch before the Host opens its Agent request', async () => {
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    turns.push(turn.request.message);
    return reply(turn, 'done');
  });
  try {
    const service = h.resident.dispatch;
    const stopped: boolean[] = [];
    service.onQueueChange(snapshot => {
      if (snapshot.activeDispatch?.dispatchId === 'a' && !stopped.length) stopped.push(service.stop(snapshot.activeDispatch.dispatchId));
    });
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    await waitFor(() => h.events.some(event => event.dispatchId === 'b' && event.state === 'completed'));
    assert.deepEqual(stopped, [true]);
    assert.deepEqual(turns, ['B']);
    assert.deepEqual(h.events.filter(event => event.dispatchId === 'a').map(event => event.state), ['queued', 'interrupted']);
  } finally { await h.close(); }
});

test('supersede cancels a pending candidate during readiness without touching the unrelated FIFO order', async () => {
  const started = deferred(), releaseActive = deferred(), reading = deferred(), releaseRead = deferred();
  let candidateThread: string | undefined;
  const candidate = { ...target, session: { id: 'worker:00000002', create: true } };
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const text = turn.request.message;
    turns.push(text);
    if (text === 'A') { started.resolve(); await releaseActive.promise; }
    return reply(turn, text);
  }, { beforeReadState: async threadId => {
    if (threadId !== candidateThread) return;
    candidateThread = undefined;
    reading.resolve();
    await releaseRead.promise;
  } });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    await service.dispatch({ ...candidate, request: 'B', dispatchId: 'b' });
    await service.dispatch({ ...target, scope: { ...scope, id: 'unrelated' }, request: 'U', dispatchId: 'u' });
    const replacement = { ...candidate, request: 'D', dispatchId: 'd' };
    await assert.rejects(service.supersede(replacement, { pendingDispatchIds: ['b', 'u'] }), PetDispatchRefusedError);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['b', 'u']);
    candidateThread = h.context.sessions.getSession('worker', candidate.session.id)!.threadId;
    releaseActive.resolve();
    await reading.promise;
    assert.deepEqual(await service.supersede(replacement, { pendingDispatchIds: ['b'] }), { stop: 'not_requested' });
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['u', 'd']);
    releaseRead.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'd' && event.state === 'completed'));
    assert.deepEqual(turns, ['A', 'U', 'D']);
    assert.deepEqual(h.events.filter(event => event.dispatchId === 'b').map(event => event.state), ['queued', 'superseded']);
  } finally { releaseActive.resolve(); releaseRead.resolve(); await h.close(); }
});

test('a scoped supersede commits pending replacements before requesting stop on the exact execution', async () => {
  const started = deferred(), release = deferred();
  let signal!: AbortSignal;
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const text = turn.request.message;
    turns.push(text);
    if (text === 'A') {
      signal = turn.setup.input.signal!;
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
    }
    return reply(turn, text);
  });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    const stopDispatchId = service.getQueueSnapshot().activeDispatch!.dispatchId;
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    await service.dispatch({ ...target, request: 'U', dispatchId: 'u' });
    const replacement = { ...target, request: 'D', dispatchId: 'd' };
    await assert.rejects(service.supersede(replacement, { pendingDispatchIds: ['b', 'missing'], stopDispatchId }), PetDispatchRefusedError);
    assert.equal(signal.aborted, false);
    let queuedOnAbort: string[] | undefined;
    signal.addEventListener('abort', () => {
      queuedOnAbort = service.getQueueSnapshot().entries?.map(entry => entry.dispatchId);
    }, { once: true });
    assert.deepEqual(await service.supersede(replacement, { pendingDispatchIds: ['b'], stopDispatchId }), { stop: 'requested' });
    assert.deepEqual(queuedOnAbort, ['u', 'd']);
    assert.deepEqual(turns, ['A']);
    release.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'd' && event.state === 'completed'));
    assert.deepEqual(turns, ['A', 'U', 'D']);
  } finally { release.resolve(); await h.close(); }
});

test('a standalone stop that settles into review keeps same-Session work waiting and lets other ready work run', async () => {
  const started = deferred(), release = deferred();
  const turns: string[] = [];
  let h!: Awaited<ReturnType<typeof fixture>>;
  h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    const text = turn.request.message;
    turns.push(text);
    if (text === 'A') {
      started.resolve();
      await release.promise;
      h.reviews.set(turn.setup.input.threadId!, buildReviewSpec({ id: 'approval',
        view: { kind: 'plain', body: 'Approve this operation?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }));
      turn.setup.input.signal!.throwIfAborted();
    }
    return reply(turn, text);
  });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'A', dispatchId: 'a' });
    await started.promise;
    await service.dispatch({ ...target, request: 'B', dispatchId: 'b' });
    await service.dispatch({ ...target, session: { id: 'worker:00000002', create: true }, request: 'C', dispatchId: 'c' });
    assert.equal(service.stop(service.getQueueSnapshot().activeDispatch!.dispatchId), true);
    release.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'c' && event.state === 'completed'));
    await waitFor(() => service.getQueueSnapshot().activeOperation === null);
    assert.deepEqual(turns, ['A', 'C']);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['b']);
    assert.ok(h.events.some(event => event.dispatchId === 'a' && event.state === 'waiting'));
    assert.equal(h.context.sessions.getSession('worker', sessionId)?.pendingDispatch?.dispatchId, 'a');
  } finally { release.resolve(); await h.close(); }
});

test('dispatch IDs cannot be reused after settlement or supersession; stale replacement changes nothing', async () => {
  const started = deferred(), release = deferred();
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    if (turn.request.message === 'active') { started.resolve(); await release.promise; }
    return reply(turn, 'done');
  });
  try {
    const service = h.resident.dispatch;
    await service.dispatch({ ...target, request: 'settled', dispatchId: 'old' });
    await waitFor(() => h.events.some(event => event.dispatchId === 'old' && event.state === 'completed'));
    await service.dispatch({ ...target, request: 'active', dispatchId: 'active' });
    await started.promise;
    await assert.rejects(service.dispatch({ ...target, request: 'reuse old', dispatchId: 'old' }), /already been admitted/);
    await service.dispatch({ ...target, request: 'pending', dispatchId: 'pending' });
    await assert.rejects(service.supersede({ ...target, request: 'stale', dispatchId: 'new' },
      { pendingDispatchIds: ['old', 'pending'] }), PetDispatchRefusedError);
    await assert.rejects(service.supersede({ ...target, request: 'reuse old as replacement', dispatchId: 'old' },
      { pendingDispatchIds: ['pending'] }), /already been admitted/);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['pending']);
    assert.deepEqual(await service.supersede({ ...target, request: 'valid', dispatchId: 'new' },
      { pendingDispatchIds: ['pending'], stopDispatchId: 'old' }), { stop: 'not_active' });
    await assert.rejects(service.dispatch({ ...target, request: 'reuse superseded', dispatchId: 'pending' }), /already been admitted/);
    assert.deepEqual(service.getQueueSnapshot().entries?.map(entry => entry.dispatchId), ['new']);
    assert.deepEqual(h.events.filter(event => event.dispatchId === 'pending').map(event => event.state), ['queued', 'superseded']);
    release.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'new' && event.state === 'completed'));
  } finally { release.resolve(); await h.close(); }
});

test('concurrent submissions of a dispatch ID admit it only once across context resolution', async () => {
  const resolving = deferred(), release = deferred();
  const turns: string[] = [];
  const h = await fixture(async turn => {
    assert.equal(turn.request.kind, 'user_message');
    turns.push(turn.request.message);
    return reply(turn, 'done');
  }, { resolveInvocationContext: async ({ request }) => {
    if (request === 'slower') { resolving.resolve(); await release.promise; }
    return [];
  } });
  try {
    const service = h.resident.dispatch;
    const slow = service.dispatch({ ...target, request: 'slower', dispatchId: 'same' });
    await resolving.promise;
    await service.dispatch({ ...target, request: 'winner', dispatchId: 'same' });
    release.resolve();
    await assert.rejects(slow, /already been admitted/);
    await waitFor(() => h.events.some(event => event.dispatchId === 'same' && event.state === 'completed'));
    assert.deepEqual(turns, ['winner']);
  } finally { release.resolve(); await h.close(); }
});
