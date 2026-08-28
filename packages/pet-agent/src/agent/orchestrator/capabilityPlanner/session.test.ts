import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import { createPlannerSession, updatePlannerSession } from './session';

const disclosure: CapabilityDisclosureState = {
  registryDigest: 'a'.repeat(64),
  defaultCapabilityName: 'general',
  disclosedCapabilityNames: ['general'],
  emptySearchRounds: 1,
  maxEmptySearchRounds: 2,
  status: 'open',
};

test('a new run creates a fresh Planner session without prior search or commit state', () => {
  const first = createPlannerSession({
    runId: 'run-1',
    plan: [{ capability: 'general', task: 'First task' }],
    capabilityDisclosure: disclosure,
  });
  const committed = updatePlannerSession({
    current: first,
    plan: [{ capability: 'general', task: 'Remaining task' }],
    capabilityDisclosure: disclosure,
    inputId: 'boundary-1',
    registryDigest: disclosure.registryDigest,
    decision: { action: 'continue_current', tasks: [] },
  });
  const nextRunDisclosure = {
    ...disclosure,
    emptySearchRounds: 0,
  };
  const nextRun = createPlannerSession({
    runId: 'run-2',
    capabilityDisclosure: nextRunDisclosure,
  });

  assert.equal(committed.revision, 1);
  assert.equal(committed.lastCommit?.inputId, 'boundary-1');
  assert.deepEqual(committed.plan, [{ capability: 'general', task: 'Remaining task' }]);
  assert.equal(nextRun.revision, 0);
  assert.deepEqual(nextRun.plan, []);
  assert.equal(nextRun.capabilityDisclosure.emptySearchRounds, 0);
  assert.equal(nextRun.lastCommit, null);
});
