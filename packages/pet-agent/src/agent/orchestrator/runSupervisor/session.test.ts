import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import { createRunSupervisorSession, updateRunSupervisorSession } from './session';

const disclosure: CapabilityDisclosureState = {
  registryDigest: 'a'.repeat(64),
  disclosedCapabilityNames: ['general'],
  emptySearchRounds: 1,
  maxEmptySearchRounds: 2,
  status: 'open',
};

test('a new run creates a fresh Supervisor session without prior search or command state', () => {
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
    emptySearchRounds: 0,
  };
  const nextRun = createRunSupervisorSession({
    runId: 'run-2',
    capabilityDisclosure: nextRunDisclosure,
  });

  assert.equal(committed.revision, 1);
  assert.equal(Object.hasOwn(committed, 'lastCommand'), false);
  assert.deepEqual(committed.plan, [{ capability: 'general', task: 'Remaining task' }]);
  assert.equal(nextRun.revision, 0);
  assert.deepEqual(nextRun.plan, []);
  assert.equal(nextRun.capabilityDisclosure.emptySearchRounds, 0);
  assert.equal(Object.hasOwn(nextRun, 'lastCommand'), false);
});
