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
async function createWaitingHost() {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-session-port-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const threads = new Map<string, { messages: AIMessage[]; reviewing: boolean }>();
  const turns: string[] = [];
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
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    sessionStatePath: join(runtimeConfig.stateRoot, 'pet-sessions.json'),
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
  return { host, threads, turns, lifecycle, gates };
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
