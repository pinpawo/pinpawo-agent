import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import { createRunSupervisorSession, updateRunSupervisorSession } from './session';

const disclosure: CapabilityDisclosureState = {
  registryDigest: 'a'.repeat(64),
  disclosedCapabilityNames: ['general'],

};

test('a new run creates a fresh Supervisor session without prior invocation or command state', () => {
  const first = createRunSupervisorSession({
    runId: 'run-1',
    plan: [{ capability: 'general', task: 'First task' }],
    capabilityDisclosure: disclosure,
  });
  const committed = updateRunSupervisorSession({
    current: first,
    plan: [{ capability: 'general', task: 'Remaining task' }],
    capabilityDisclosure: disclosure,

  });
  const nextRunDisclosure = {
    ...disclosure,

  };
  const nextRun = createRunSupervisorSession({
    runId: 'run-2',
    capabilityDisclosure: nextRunDisclosure,
  });

  assert.equal(Object.hasOwn(committed, 'lastCommand'), false);
  assert.deepEqual(committed.plan, [{ capability: 'general', task: 'Remaining task' }]);
  assert.deepEqual(nextRun.plan, []);
  assert.deepEqual(nextRun.capabilityDisclosure.disclosedCapabilityNames, ['general']);
  assert.equal(Object.hasOwn(nextRun, 'lastCommand'), false);
});
