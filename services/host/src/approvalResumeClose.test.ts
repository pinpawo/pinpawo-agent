import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReviewSpec } from '@pinpawo/pet-agent';
import type { AgentServerMessage } from '@pinpawo/agent-session';
import { buildHostRuntimeConfig } from './config/runtimeConfig';
import { FileSaver } from './fileSaver';
import { readResidentPetRuntimeContext } from './host/runtimeContext';
import {
  createResidentPetInteraction,
  createResidentPetRuntime,
  createResidentPetSessions,
  type AgentSessionPeer,
} from './residentPetHost';
import { createTestModelProfiles } from './testing/modelProfiles';
import { HostToolkitInventoryStore } from './toolkits/toolkitInventory';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const entry of ['peer', 'request', 'session'] as const) {
  for (const checkpointRead of [1, 2]) {
    for (const decision of entry === 'session' ? ['approve'] as const : ['approve', 'cancel'] as const) {
      test(`Host close fences ${entry} ${decision} while resume checkpoint read ${checkpointRead} is pending`, { timeout: 10_000 }, async t => {
        const root = await mkdtemp(join(tmpdir(), 'pinpawo-resume-close-'));
        const config = buildHostRuntimeConfig(root);
        const reading = deferred();
        const release = deferred();
        const review = buildReviewSpec({ id: 'review', view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }] });
        const pending = { interruptId: 'pending', payload: { kind: 'human_review' as const, reviews: [review] } };
        let armed = false;
        let reads = 0;
        let turns = 0;
        let settlements = 0;
        let current: typeof pending | null = pending;
        const messages: AgentServerMessage[] = [];
        const runtime = await createResidentPetRuntime({
          petId: 'pet', petName: 'Pet', runtimeConfig: config,
          modelProfiles: createTestModelProfiles(), capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
          checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
          toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
          graphService: {
            readThreadState: async () => {
              // The exact-session surface reads a snapshot before admitting the resume.
              if (armed && ++reads === checkpointRead + (entry === 'session' ? 1 : 0)) {
                reading.resolve();
                await release.promise;
              }
              return { messages: [], pendingInterrupt: current, acceptsResume: !!current, currentPlan: null };
            },
            settleAbortedRun: async () => { settlements++; return current; },
          } as never,
          runAgentTurn: async () => {
            turns++;
            current = null;
            return { status: 'completed', reply: 'consumed' };
          },
        });
        const context = readResidentPetRuntimeContext(runtime);
        const interaction = createResidentPetInteraction(runtime);
        const sessions = createResidentPetSessions(runtime);
        const sessionId = context.sessions.getActiveSessionId('pet');
        const peer: AgentSessionPeer = { isConnected: () => true, send: message => { messages.push(message); return true; } };
        if (entry === 'peer') interaction.connect(peer);
        else interaction.subscribe(message => messages.push(message));
        t.after(async () => { release.resolve(); await context.close(); await rm(root, { recursive: true, force: true }); });
        armed = true;
        const value = { decisions: [{ interactionId: 'review', selectedOptionId: 'approve' }] };
        const message = { type: 'interrupt.resume' as const, requestId: 'resume', interruptId: 'pending',
          value: decision === 'cancel' ? { action: 'cancel' } : value };
        const resuming = entry === 'peer' ? interaction.handle(peer, message)
          : entry === 'request' ? interaction.request(message)
          : sessions.review(sessionId, { requestId: 'resume', interruptId: 'pending', value });
        await reading.promise;
        let closed = false;
        const closing = context.close().then(() => { closed = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(closed, false, 'close must wait for the admitted resume to settle');
        release.resolve();
        await Promise.all([resuming, closing]);
        assert.equal(turns, 0, 'a close during checkpoint preflight must not invoke the Agent');
        assert.equal(settlements, 0, 'an unstarted resume must not settle or cancel the checkpoint');
        assert.deepEqual(current, pending, 'close must preserve the pending review unchanged');
        assert.ok(!messages.some(message => message.type === 'event' && message.event.type === 'run.started'),
          'an unstarted resume must not be announced as a run');
        await assert.rejects(sessions.review(sessionId, { requestId: 'late', interruptId: 'pending', value }), /closed/);
      });
    }
  }
}

// acceptRoute is synchronous, but its caller awaits its result before starting
// the run. Close in that gap must have the same fence as the checkpoint reads.
test('Host close fences a resume after accepting its review route', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-resume-route-close-'));
  const config = buildHostRuntimeConfig(root);
  const review = buildReviewSpec({ id: 'review', view: { kind: 'plain', body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }] });
  const pending = { interruptId: 'pending', payload: { kind: 'human_review' as const, reviews: [review] } };
  let turns = 0;
  const runtime = await createResidentPetRuntime({
    petId: 'pet', petName: 'Pet', runtimeConfig: config,
    modelProfiles: createTestModelProfiles(), capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
    checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: pending, acceptsResume: true, currentPlan: null }) } as never,
    runAgentTurn: async () => { turns++; return { status: 'completed', reply: 'consumed' }; },
  });
  const context = readResidentPetRuntimeContext(runtime);
  const interaction = createResidentPetInteraction(runtime);
  const peer: AgentSessionPeer = { isConnected: () => true, send: () => true };
  interaction.connect(peer);
  t.after(async () => { await context.close(); await rm(root, { recursive: true, force: true }); });
  const getActiveSessionId = context.sessions.getActiveSessionId.bind(context.sessions);
  let lookups = 0;
  let closing: Promise<void> | undefined;
  context.sessions.getActiveSessionId = petId => {
    const id = getActiveSessionId(petId);
    // The first lookup claims the active run; the second accepts the route.
    if (++lookups === 2) queueMicrotask(() => { closing = context.close(); });
    return id;
  };
  await interaction.handle(peer, { type: 'interrupt.resume', requestId: 'resume', interruptId: 'pending',
    value: { decisions: [{ interactionId: 'review', selectedOptionId: 'approve' }] } });
  assert.ok(closing, 'the route acceptance must trigger the close');
  await closing;
  assert.equal(turns, 0, 'an accepted route must not start after Host close');
});
