import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentModels } from '../../../../types/agent';
import { buildRunStateReset, type OrchestratorStateType } from '../../state';
import { createRunSupervisorSession } from '../../runSupervisor/session';
import { createAnswerNode } from './answer';

const models = { act: { invoke: () => { throw new Error('Terminal must not invoke a model'); } } } as unknown as AgentModels;
function state(patch: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return { ...buildRunStateReset(), messages: [], sessionCapabilityArtifacts: [], taskActiveDelegation: null,
    taskRunContinuation: null, sessionToolAuthorizations: { generation: '', records: [] }, ...patch };
}

test('terminal delivers supplied text intact, once, and clears invocation state without a model', async () => {
  const reply = '  检查已完成。\n\n请选择下一项。  ';
  const result = await createAnswerNode({ models })(state({ runSupervisorReply: reply }));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, reply);
  assert.equal(result.runSupervisorReply, null);
  assert.equal(result.runSupervisorSession, null);
  assert.equal(result.taskRunContinuation, null);
});

test('terminal preserves a remaining plan after accepting the active task', async () => {
  const plan = [{ capability: 'general', task: 'Publish after the user chooses a target.' }];
  const result = await createAnswerNode({ models })(state({
    runUserRequest: 'Prepare and publish.', traceId: 'task-1', runSupervisorReply: 'Choose a target.',
    runSupervisorSession: createRunSupervisorSession({ runId: 'run-1', plan, capabilityDisclosure: {
      registryDigest: 'registry', disclosedCapabilityNames: ['general'], emptySearchRounds: 0,
      maxEmptySearchRounds: 2, status: 'open',
    } }),
  }));
  assert.deepEqual(result.taskRunContinuation, {
    traceId: 'task-1', userRequest: 'Prepare and publish.', activeDelegationId: null, remainingPlan: plan,
  });
});

test('terminal does not fabricate a reply for a missing proposal and empty text', async () => {
  await assert.rejects(createAnswerNode({ models })(state()), /requires a supplied reply/);
});

test('root iteration stop is rendered deterministically', async () => {
  const result = await createAnswerNode({ models, maxRunIterations: 2 })(state({ runIterationCount: 2 }));
  assert.equal(result.messages.length, 1);
  assert.equal(result.runIterationCount, 0);
});
