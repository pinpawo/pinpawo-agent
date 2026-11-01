import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentServerMessage } from '@pinpawo/agent-session';
import { buildReviewSpec, type CapabilityArtifactStore } from '@pinpawo/pet-agent';

import {
  createResidentPetHost,
  PetSessionNotFoundError,
  PetSessionReviewRefusedError,
  type AgentSessionPeer,
  type PetDispatchLifecycleEvent,
} from '../residentPetHost';
import { FileSaver } from '../fileSaver';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';

const testArtifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('not used'); },
  readArtifact: async () => { throw new Error('not used'); },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function events(messages: readonly AgentServerMessage[]) {
  return messages.flatMap((message) => message.type === 'event' ? [message.event] : []);
}

const review = buildReviewSpec({
  id: 'review-1',
  view: { kind: 'plain', body: 'Approve B?' },
  options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
});

/**
 * One Pet whose TUI sits on its active session while a Channel dispatch waits
 * for review in another. Each thread's checkpoint is a plain map entry.
 */
async function createWaitingHost(resolveInvocationContext?: Parameters<typeof createResidentPetHost>[0]['resolveInvocationContext']) {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-session-port-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const threads = new Map<string, { messages: AIMessage[]; reviewing: boolean }>();
  const turns: string[] = [];
  const promptSnapshots: Array<{ threadId: string; kind: string; sections: readonly { id: string; owner?: string; content: string }[] }> = [];
  // Tests hold a resumed run, or one checkpoint read, open on these.
  const gates: { resume?: Promise<void>; read?: Promise<void> } = {};
  const host = await createResidentPetHost({
    petId: 'pet',
    petName: 'Pet',
    modelProfiles: createTestModelProfiles(),
    capabilities: [],
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: testArtifactStore,
    checkpointer: new FileSaver(runtimeConfig.checkpointPath),
    runtimeConfig,
    toolAuthorizationMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    sessionStatePath: join(runtimeConfig.stateRoot, 'pet-sessions.json'),
    ...(resolveInvocationContext ? { resolveInvocationContext } : {}),
    graphService: {
      readThreadState: async (setup: { input: { threadId?: string } }) => {
        const thread = threads.get(setup.input.threadId ?? '');
        const read = gates.read;
        gates.read = undefined;
        await read;
        return {
          messages: thread?.messages ?? [],
          pendingInterrupt: thread?.reviewing
            ? { interruptId: 'interrupt-1', payload: { kind: 'human_review' as const, reviews: [review] } }
            : null,
          acceptsResume: thread?.reviewing ?? false,
          currentPlan: null,
        };
      },
      settleAbortedRun: async () => null,
    } as never,
    runAgentTurn: async ({ request, setup, emitEvent }) => {
      const threadId = setup.input.threadId ?? '';
      turns.push(`${threadId}:${request.kind}`);
      promptSnapshots.push({ threadId, kind: request.kind, sections: [...(setup.input.context?.systemPromptSections ?? [])] });
      if (request.kind === 'user_message') {
        threads.set(threadId, { messages: [new AIMessage('needs approval')], reviewing: true });
        emitEvent({
          type: 'interrupt.requested',
          requestId: request.requestId,
          pendingInterrupt: {
            interruptId: 'interrupt-1',
            payload: { kind: 'human_review', interactions: [] },
          },
        });
        return { status: 'waiting' };
      }
      await gates.resume;
      threads.set(threadId, { messages: [new AIMessage('approved')], reviewing: false });
      emitEvent({
        type: 'message.completed', requestId: request.requestId, messageId: 'm-approved', role: 'assistant', text: 'approved',
      });
      return { status: 'completed', reply: 'approved' };
    },
  });
  const lifecycle: PetDispatchLifecycleEvent[] = [];
  host.resident.dispatch.onDispatchLifecycle((event) => lifecycle.push(event));
  return { host, threads, turns, lifecycle, gates, promptSnapshots };
}

test('an exact session is read, followed and reviewed without changing the active session', async () => {
  const { host, turns, lifecycle } = await createWaitingHost();
  const tui: AgentServerMessage[] = [];
  const tuiPeer: AgentSessionPeer = { isConnected: () => true, send: (message) => { tui.push(message); return true; } };
  const petLevel: AgentServerMessage[] = [];
  try {
    await host.interaction.connect(tuiPeer);
    host.interaction.subscribe((message) => petLevel.push(message));
    const active = await host.interaction.snapshot();
    assert.equal(active.type, 'session.snapshot.result');
    const activeId = active.type === 'session.snapshot.result' ? active.snapshot.session.sessionId : '';

    const target = 'pet:0000000b';
    await host.resident.dispatch.dispatch({ request: 'work in B', dispatchId: 'd-1', session: { id: target, create: true } });
    await waitFor(() => lifecycle.some((event) => event.state === 'waiting'), 'B did not wait for review');

    // The waiting run belongs to B: neither the TUI nor the Pet-level stream saw it.
    assert.equal(events([...tui, ...petLevel]).length, 0);

    const snapshot = await host.sessions.snapshot(target);
    assert.equal(snapshot.session.sessionId, target);
    assert.equal(snapshot.session.pendingInterrupt?.interruptId, 'interrupt-1');
    assert.equal(snapshot.session.activeRun, null);

    const observed: AgentServerMessage[] = [];
    const detach = await host.sessions.observe(target, (message) => observed.push(message));
    assert.equal(observed[0]?.type, 'session.snapshot.result');

    // An answer to an interrupt that is not current is refused before the Host takes it.
    await assert.rejects(host.sessions.review(target, {
      requestId: 'stale', interruptId: 'old-interrupt', value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }] },
    }), (error) => error instanceof PetSessionReviewRefusedError && error.code === 'review_closed');

    await host.sessions.review(target, {
      requestId: 'approve-b', interruptId: 'interrupt-1', value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }] },
    });
    await waitFor(() => lifecycle.some((event) => event.state === 'completed'), 'the dispatch did not continue');

    // The resumed run is B's original dispatch, observed on B only.
    assert.equal(turns.at(-1)?.endsWith(':resume'), true);
    const completed = lifecycle.find((event) => event.state === 'completed');
    assert.equal(completed?.dispatchId, 'd-1');
    assert.equal(completed?.sessionId, target);
    assert.deepEqual(
      events(observed).filter((event) => event.requestId === 'approve-b').map((event) => event.type),
      ['run.started', 'message.completed'],
    );
    assert.equal(events([...tui, ...petLevel]).length, 0);

    const after = await host.interaction.snapshot();
    assert.equal(after.type === 'session.snapshot.result' && after.snapshot.session.sessionId, activeId);

    // A second answer to the same review finds it closed and runs nothing.
    const turnCount = turns.length;
    await assert.rejects(host.sessions.review(target, {
      requestId: 'again', interruptId: 'interrupt-1', value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }] },
    }), (error) => error instanceof PetSessionReviewRefusedError && error.code === 'review_closed');
    assert.equal(turns.length, turnCount);
    detach();
  } finally {
    await host.close();
  }
});

test('provider snapshots stay scoped across dispatch, mutation, resume and ordinary chat', async () => {
  const id = 'channel:collaboration';
  const original = [{ id, owner: 'channel', content: 'Channel A original' }];
  const sections = new Map([
    ['A', original],
    ['B', [{ id, owner: 'channel', content: 'Channel B' }]],
  ]);
  const resolvedTargets: Array<{ petId: string; sessionId?: string; scope: { namespace: string; id: string } }> = [];
  const { host, lifecycle, promptSnapshots } = await createWaitingHost(async (target) => {
    resolvedTargets.push(target);
    return sections.get(target.scope.id);
  });
  const tuiPeer: AgentSessionPeer = { isConnected: () => true, send: () => true };
  const onlyChannel = (sections: readonly { id: string; content: string }[]) => sections.filter((section) => section.id === id);
  try {
    await host.interaction.connect(tuiPeer);
    const a = 'pet:0000000a';
    const b = 'pet:0000000b';
    await host.resident.dispatch.dispatch({
      request: 'A', dispatchId: 'dispatch-a', session: { id: a, create: true },
      scope: { namespace: 'channel', id: 'A' },
    });
    original[0]!.content = 'Channel A edited after admission';
    await waitFor(() => lifecycle.some((event) => event.dispatchId === 'dispatch-a' && event.state === 'waiting'), 'A did not suspend');
    await host.resident.dispatch.dispatch({
      request: 'B', dispatchId: 'dispatch-b', session: { id: b, create: true },
      scope: { namespace: 'channel', id: 'B' },
    });
    await waitFor(() => lifecycle.some((event) => event.dispatchId === 'dispatch-b' && event.state === 'waiting'), 'B did not suspend');
    const starts = promptSnapshots.filter((entry) => entry.kind === 'user_message');
    assert.deepEqual(starts.map((entry) => onlyChannel(entry.sections)), [
      [{ id, owner: 'channel', content: 'Channel A original' }],
      [{ id, owner: 'channel', content: 'Channel B' }],
    ]);
    await host.sessions.review(a, {
      requestId: 'resume-a', interruptId: 'interrupt-1', value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }] },
    });
    await waitFor(() => lifecycle.some((event) => event.dispatchId === 'dispatch-a' && event.state === 'completed'), 'A did not resume');
    const resume = promptSnapshots.find((entry) => entry.kind === 'resume');
    assert.deepEqual(onlyChannel(resume?.sections ?? []), [{ id, owner: 'channel', content: 'Channel A original' }]);
    await host.interaction.handle(tuiPeer, { type: 'chat_request', requestId: 'plain-chat', message: 'ordinary chat' });
    assert.deepEqual(onlyChannel(promptSnapshots.at(-1)?.sections ?? []), [], 'ordinary chat does not inherit a Channel prompt');
    assert.deepEqual(resolvedTargets, [
      { petId: 'pet', sessionId: a, scope: { namespace: 'channel', id: 'A' } },
      { petId: 'pet', sessionId: b, scope: { namespace: 'channel', id: 'B' } },
    ]);
  } finally {
    await host.close();
  }
});

test('a failing context provider rejects admission without creating a session', async () => {
  const { host, lifecycle } = await createWaitingHost(async () => { throw new Error('context unavailable'); });
  try {
    await assert.rejects(host.resident.dispatch.dispatch({
      request: 'work', session: { id: 'pet:0000000c', create: true }, scope: { namespace: 'channel', id: 'c' },
    }), /context unavailable/);
    await assert.rejects(host.sessions.snapshot('pet:0000000c'), PetSessionNotFoundError);
    assert.equal(lifecycle.length, 0);
  } finally {
    await host.close();
  }
});

test('provider receives a stable target while admission waits, and a closed Host rejects the result', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let targetSeen: { petId: string; sessionId?: string; scope: { namespace: string; id: string } } | undefined;
  const { host, lifecycle } = await createWaitingHost(async (target) => {
    targetSeen = target;
    await gate;
    return [{ id: 'context', content: 'value' }];
  });
  const session = { id: 'pet:0000000d', create: true };
  const scope = { namespace: 'channel', id: 'A' };
  const admission = host.resident.dispatch.dispatch({ request: 'work', session, scope });
  session.id = 'pet:0000000e';
  scope.id = 'B';
  assert.deepEqual(targetSeen, { petId: 'pet', sessionId: 'pet:0000000d', scope: { namespace: 'channel', id: 'A' } });
  await host.close();
  release();
  await assert.rejects(admission, /closing/);
  assert.equal(lifecycle.length, 0);
});

test('an unknown session is refused without creating one', async () => {
  const { host } = await createWaitingHost();
  try {
    await assert.rejects(host.sessions.snapshot('pet:deadbeef'), PetSessionNotFoundError);
    await assert.rejects(host.sessions.observe('pet:deadbeef', () => undefined), PetSessionNotFoundError);
    await assert.rejects(host.sessions.review('pet:deadbeef', {
      requestId: 'r', interruptId: 'i', value: { decisions: [] },
    }), PetSessionNotFoundError);
    await assert.rejects(host.sessions.snapshot('pet:deadbeef'), PetSessionNotFoundError);
  } finally {
    await host.close();
  }
});

test('observing the active session follows its conversation turns', async () => {
  const { host } = await createWaitingHost();
  const tuiPeer: AgentSessionPeer = { isConnected: () => true, send: () => true };
  try {
    await host.interaction.connect(tuiPeer);
    const active = await host.interaction.snapshot();
    const activeId = active.type === 'session.snapshot.result' ? active.snapshot.session.sessionId : '';
    const observed: AgentServerMessage[] = [];
    const detach = await host.sessions.observe(activeId, (message) => observed.push(message));
    await host.interaction.handle(tuiPeer, { type: 'chat_request', requestId: 'chat-1', message: 'hello' });
    assert.ok(events(observed).some((event) => event.type === 'run.started' && event.requestId === 'chat-1'));
    const snapshot = await host.sessions.snapshot(activeId);
    assert.equal(snapshot.session.pendingInterrupt?.interruptId, 'interrupt-1');
    detach();
  } finally {
    await host.close();
  }
});

async function waitInReview(host: Awaited<ReturnType<typeof createWaitingHost>>) {
  const target = 'pet:0000000b';
  await host.host.resident.dispatch.dispatch({ request: 'work in B', dispatchId: 'd-1', session: { id: target, create: true } });
  await waitFor(() => host.lifecycle.some((event) => event.state === 'waiting'), 'B did not wait for review');
  return target;
}

const approve = (requestId: string) => ({
  requestId, interruptId: 'interrupt-1', value: { decisions: [{ interactionId: 'review-1', selectedOptionId: 'approve' }] },
});

test('a second answer while the first is resuming is refused as busy, and runs nothing', async () => {
  const waiting = await createWaitingHost();
  const { host, turns, lifecycle, gates } = waiting;
  let open!: () => void;
  gates.resume = new Promise((resolve) => { open = resolve; });
  try {
    const target = await waitInReview(waiting);
    // Two windows answer the same review together.
    const first = host.sessions.review(target, approve('first'));
    await assert.rejects(
      host.sessions.review(target, approve('second')),
      (error) => error instanceof PetSessionReviewRefusedError && error.code === 'session_busy',
    );
    await first;
    await waitFor(() => turns.some((turn) => turn.endsWith(':resume')), 'the first answer did not resume');
    await assert.rejects(
      host.sessions.review(target, approve('third')),
      (error) => error instanceof PetSessionReviewRefusedError && error.code === 'session_busy',
    );
    open();
    await waitFor(() => lifecycle.some((event) => event.state === 'completed'), 'the dispatch did not continue');
    assert.equal(turns.filter((turn) => turn.endsWith(':resume')).length, 1);
  } finally {
    open();
    await host.close();
  }
});

test('a snapshot read across the end of a run is read again, so the final reply is not lost', async () => {
  const waiting = await createWaitingHost();
  const { host, turns, lifecycle, gates } = waiting;
  let finishRun!: () => void;
  gates.resume = new Promise((resolve) => { finishRun = resolve; });
  try {
    const target = await waitInReview(waiting);
    await host.sessions.review(target, approve('approve-b'));
    await waitFor(() => turns.some((turn) => turn.endsWith(':resume')), 'the answer did not resume');

    // The checkpoint read starts while the run is live and returns the state
    // from before it; the run settles in between.
    let releaseRead!: () => void;
    gates.read = new Promise((resolve) => { releaseRead = resolve; });
    const reading = host.sessions.snapshot(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishRun();
    await waitFor(() => lifecycle.some((event) => event.state === 'completed'), 'the run did not settle');
    releaseRead();

    const snapshot = await reading;
    assert.equal(snapshot.session.activeRun, null);
    assert.equal(snapshot.session.pendingInterrupt, null);
    assert.ok(JSON.stringify(snapshot.session.timeline).includes('approved'));
  } finally {
    finishRun();
    await host.close();
  }
});
