import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewSpec } from '@pinpawo/pet-agent';
import type { HostGraphThreadState } from '../agent/agentGraphService';
import type { AgentSessionTurnOptions } from '../agent/chatSessionAdapter';
import { PetInvocationApprovals } from './petInvocationApprovals';
import { readPetInvocationContext } from './petInvocationContext';

function fixture() {
  const owner = new PetInvocationApprovals();
  const invocation = { petId: 'executor', dispatchId: 'original-dispatch', scope: { namespace: 'channel', id: 'channel-a' } };
  const waiting: HostGraphThreadState = { messages: [], acceptsResume: true, currentPlan: null, checkpointId: 'cp-1',
    pendingInterrupt: { interruptId: 'approval-1', payload: { kind: 'human_review', reviews: [buildReviewSpec({
      id: 'review-1', view: { kind: 'plain', body: 'Approve' }, options: [{ id: 'yes', label: 'Yes', decision: { type: 'approve' } }],
    })] } },
  };
  let state: HostGraphThreadState = { ...waiting, pendingInterrupt: null, acceptsResume: false };
  const options = { request: { kind: 'user_message', requestId: 'dispatch', message: 'work' }, setup: { input: { threadId: 'thread-a' } },
    graphService: { readThreadState: async () => state } } as unknown as AgentSessionTurnOptions;
  const resume = { ...options, request: { kind: 'resume', requestId: 'resume', resume: { interruptId: 'approval-1', value: {} } } } as AgentSessionTurnOptions;
  const bind = () => owner.runDispatch(options, invocation, async () => { state = structuredClone(waiting); return { status: 'waiting' }; });
  return { owner, options, resume, bind, invocation, waiting, set: (value: HostGraphThreadState) => { state = value; } };
}

test('approval association requires the original checkpoint, interrupt, review and thread', async () => {
  for (const replacement of ['checkpoint', 'interrupt', 'review', 'closed', 'missing-checkpoint']) {
    const f = fixture(); await f.bind();
    const altered = structuredClone(f.waiting);
    if (replacement === 'checkpoint') altered.checkpointId = 'different';
    if (replacement === 'interrupt') altered.pendingInterrupt!.interruptId = 'different';
    if (replacement === 'review' && altered.pendingInterrupt?.payload.kind === 'human_review') altered.pendingInterrupt.payload.reviews[0]!.id = 'different';
    if (replacement === 'closed') altered.pendingInterrupt = null;
    if (replacement === 'missing-checkpoint') delete altered.checkpointId;
    f.set(altered);
    let calls = 0;
    await assert.rejects(f.owner.runInteraction(f.resume, async () => { calls++; return { status: 'completed', reply: 'no' }; }), /association/);
    assert.equal(calls, 0);
  }
  const f = fixture(); await f.bind();
  await f.owner.runInteraction({ ...f.resume, setup: { ...f.resume.setup, input: { ...f.resume.setup.input, threadId: 'other-thread' } } }, async () => {
    assert.equal(readPetInvocationContext(), undefined); return { status: 'completed', reply: 'unscoped' };
  });
  await f.owner.runInteraction(f.resume, async () => {
    assert.deepEqual(readPetInvocationContext(), f.invocation); return { status: 'completed', reply: 'original' };
  });
});

test('completion, failed resume, unchanged waiting checkpoint and runtime close revoke approval identity', async () => {
  for (const result of ['completed', 'throw', 'unchanged-waiting', 'moved-waiting', 'close']) {
    const f = fixture(); await f.bind();
    if (result === 'close') f.owner.clear();
    else {
      const run = f.owner.runInteraction(f.resume, async () => {
        assert.deepEqual(readPetInvocationContext(), f.invocation);
        if (result === 'throw') throw new Error('runner failed');
        if (result === 'moved-waiting') f.set({ ...f.waiting, checkpointId: 'cp-moved' });
        return result.endsWith('waiting') ? { status: 'waiting' } : { status: 'completed', reply: 'done' };
      });
      if (result === 'throw') await assert.rejects(run, /runner failed/); else await run;
    }
    // Even a repeated raw checkpoint snapshot cannot recreate consumed authority.
    await f.owner.runInteraction(f.resume, async () => {
      assert.equal(readPetInvocationContext(), undefined); return { status: 'completed', reply: 'unscoped' };
    });
    assert.equal(readPetInvocationContext(), undefined);
  }
});

test('a scoped dispatch cannot appropriate an existing approval or bind without checkpoint evidence', async () => {
  const f = fixture(); await f.bind();
  await assert.rejects(f.owner.runDispatch(f.options, { ...f.invocation, scope: { namespace: 'channel', id: 'channel-b' } }, async () => ({ status: 'waiting' })), /existing interrupt/);
  await f.owner.runInteraction(f.resume, async () => {
    assert.deepEqual(readPetInvocationContext(), f.invocation); return { status: 'completed', reply: 'a' };
  });
  const other = fixture();
  await other.owner.runDispatch(other.options, other.invocation, async () => {
    other.set({ ...other.waiting, checkpointId: undefined }); return { status: 'waiting' };
  });
  await other.owner.runInteraction(other.resume, async () => {
    assert.equal(readPetInvocationContext(), undefined); return { status: 'completed', reply: 'no evidence' };
  });
});


test('a later approval cannot re-arm an earlier consumed checkpoint association', async () => {
  const f = fixture(); await f.bind();
  const next = structuredClone(f.waiting); next.checkpointId = 'cp-2'; next.pendingInterrupt!.interruptId = 'approval-2';
  await f.owner.runInteraction(f.resume, async () => { f.set(next); return { status: 'waiting' }; });
  await f.owner.runInteraction({ ...f.resume, request: { kind: 'resume', requestId: 'second',
    resume: { interruptId: 'approval-2', value: {} } } }, async () => {
    assert.deepEqual(readPetInvocationContext(), f.invocation);
    f.set(structuredClone(f.waiting)); return { status: 'waiting' };
  });
  await f.owner.runInteraction(f.resume, async () => {
    assert.equal(readPetInvocationContext(), undefined); return { status: 'completed', reply: 'no replay' };
  });
});
