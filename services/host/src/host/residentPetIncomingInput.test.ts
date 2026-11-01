import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReviewSpec, type CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { AgentSessionTurnOptions, AgentSessionTurnResult } from '../agent/chatSessionAdapter';
import { createResidentPetRuntime } from '../residentPetHost';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import { FileSaver } from '../fileSaver';
import { createResidentPet } from './residentPetDispatch';
import { createResidentPetSessions } from './residentPetSessions';
import { readResidentPetRuntimeContext } from './runtimeContext';
import { readPetInvocationContext } from './petInvocationContext';
import type { PetDispatchLifecycleEvent } from './contracts';

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

const artifacts: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('unused'); },
  readArtifact: async () => { throw new Error('unused'); },
  listArtifacts: async () => [], deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async uri => uri,
};
const sessionId = 'worker:00000001';
const scope = { namespace: 'channel', id: 'one' };
const target = { session: { id: sessionId, create: true }, scope };

async function fixture(run: (turn: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>, hooks: {
  beforeContextLoad?: () => Promise<void>;
  beforeReadState?: () => Promise<void>;
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
    toolkitInventory: new HostToolkitInventoryStore(), capabilityArtifactStore: artifacts,
    checkpointer: new FileSaver(runtimeConfig.checkpointPath),
    sessionStatePath: runtimeConfig.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    loadContext: async () => { await hooks.beforeContextLoad?.(); return { pet: { id: 'worker', name: 'Worker' } }; },
    resolveInvocationContext: async ({ scope }) => [{ id: 'domain', owner: scope.namespace, content: scope.id }],
    graphService: {
      readThreadState: async ({ input }: AgentSessionTurnOptions['setup']) => {
        await hooks.beforeReadState?.();
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
    resident, context, events, reviews, sessions: createResidentPetSessions(runtime),
    close: async () => { await resident.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function reply(turn: AgentSessionTurnOptions, text: string): AgentSessionTurnResult {
  turn.emitEvent({ type: 'message.completed', requestId: turn.request.requestId,
    messageId: `reply:${turn.request.requestId}`, role: 'assistant', text });
  return { status: 'completed', reply: text };
}

test('queued input interrupts only after delivery and is consumed once with its own attribution', async () => {
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
      assert.fail('The old run must not publish a stale reply.');
    }
    return reply(turn, message);
  });
  try {
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'first', request: 'first' });
    await started.promise;
    await h.resident.dispatch.dispatch({ ...target, dispatchId: 'next', request: incoming });
    assert.equal(firstSignal.aborted, false, 'ordinary dispatch waits for the delegation boundary');
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    delivered.resolve();
    await waitFor(() => h.events.some(event => event.dispatchId === 'next' && event.state === 'completed'));
    assert.deepEqual(turns.map(turn => turn.message), ['first', incoming]);
    assert.deepEqual(turns.map(turn => turn.invocation?.dispatchId), ['first', 'next']);
    assert.ok(h.events.some(event => event.dispatchId === 'first' && event.state === 'interrupted'));
    assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => [event.dispatchId, event.message?.text]), [['next', incoming]]);
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

test('a matching input is preferred without consuming another session or scope, and preserves target FIFO', async () => {
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
    await waitFor(() => h.events.filter(event => event.state === 'completed').length === 7);
    assert.deepEqual(turns, ['first', 'next-1', 'other-session', 'other-namespace', 'other-channel', 'unscoped', 'implicit-session', 'next-2']);
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
      assert.fail('Queued input must also be considered after a reviewed dispatch resumes.');
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
    assert.deepEqual(h.events.filter(event => event.state === 'message').map(event => event.dispatchId), ['next']);
  } finally { resumeBoundary.resolve(); await h.close(); }
});
