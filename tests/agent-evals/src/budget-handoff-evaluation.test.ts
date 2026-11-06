import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateBudgetHandoffInvariants,
  type BudgetHandoffObservation,
} from './budget-handoff-evaluation.ts';
import { budgetHandoffDataset } from './datasets/budget-handoff.ts';

const handoffExpected = budgetHandoffDataset.cases.find(({ name }) => name === 'context-window-handoff')!.expected;
const controlExpected = budgetHandoffDataset.cases.find(({ name }) => name === 'below-watermark-control')!.expected;

function completedHandoff(): BudgetHandoffObservation {
  return {
    executions: [
      { taskId: 'task-1', planItemId: 'plan-1', delegationId: 'attempt-1', status: 'returned',
        delivery: 'Report fact EVIDENCE-6429. Ticket opaque-fixture-ticket; verification is unfinished.' },
      { taskId: 'task-1', planItemId: 'plan-1', delegationId: 'attempt-2', status: 'returned',
        delivery: 'EVIDENCE-6429 and verified VERIFY-3817.' },
    ],
    toolCalls: [
      { name: 'read_evidence', delegationId: 'attempt-1', success: true },
      { name: 'verify_evidence', delegationId: 'attempt-2', success: true },
    ],
    notices: [{ reason: 'context_window', phase: 'finalize', paired: true, delegationId: 'attempt-1' }],
    continuationInputs: [{ delegationId: 'attempt-2', hasPriorDelivery: true, hasPrivateToolHistory: false }],
    planCompleted: true,
    finalText: 'The report confirms EVIDENCE-6429; actual verification returned VERIFY-3817.',
    invocationError: null,
  };
}

function completedControl(): BudgetHandoffObservation {
  const observation = completedHandoff();
  observation.executions = [{
    ...observation.executions[0], delivery: 'EVIDENCE-6429 and verified VERIFY-3817.',
  }];
  observation.toolCalls[1].delegationId = 'attempt-1';
  observation.notices = [];
  observation.continuationInputs = [];
  return observation;
}

function passes(observation: BudgetHandoffObservation, expected = handoffExpected): boolean {
  const invariants = evaluateBudgetHandoffInvariants(observation, expected);
  assert.ok(invariants.length > 0, 'the eval must have mechanical acceptance checks');
  return invariants.every(({ passed }) => passed);
}

test('budget handoff dataset has executable identities, mechanical expectations and semantic acceptance criteria', () => {
  const cases = budgetHandoffDataset.cases;
  assert.equal(cases.length, 2);
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  assert.deepEqual(cases.map(({ expected }) => expected.contextHandoff), [true, false]);
  assert.deepEqual(cases.map(({ expected }) => expected.expectedDelegations), [2, 1]);
  for (const { input, expected } of cases) {
    assert.equal(input.contextWindowTokens, 16_000);
    assert.equal(input.generationReserveTokens, 0);
    assert.ok(input.reportChars > 0);
    const criterionIds = expected.acceptanceCriteria.map(({ id }) => id);
    assert.ok(criterionIds.length > 0);
    assert.equal(new Set(criterionIds).size, criterionIds.length);
  }
  assert.ok(cases[0].input.reportChars > cases[1].input.reportChars);
});

test('mechanical scoring accepts a paired context handoff followed by same-task completion', () => {
  assert.equal(passes(completedHandoff()), true);
});

test('a completed-looking final reply cannot pass while Supervisor leaves the plan unaccepted', () => {
  const observation = completedHandoff();
  observation.planCompleted = false;
  assert.equal(passes(observation), false);
});

test('missing delivery cannot be replaced by a later completion claim', () => {
  const observation = completedHandoff();
  observation.executions[0].status = 'missing_deliverable';
  observation.executions[0].delivery = null;
  assert.equal(passes(observation), false);
});

for (const field of ['taskId', 'planItemId'] as const) {
  test(`restarting a different ${field} is not continuation of the original task`, () => {
    const observation = completedHandoff();
    observation.executions[1][field] = 'replacement';
    assert.equal(passes(observation), false);
  });
  test(`an absent ${field} cannot establish same-task continuation`, () => {
    const observation = completedHandoff();
    observation.executions.forEach(execution => { execution[field] = ''; });
    assert.equal(passes(observation), false);
  });
}

test('reusing a delegation identity does not count as a fresh context handoff', () => {
  const observation = completedHandoff();
  observation.executions[1].delegationId = 'attempt-1';
  observation.toolCalls[1].delegationId = 'attempt-1';
  observation.continuationInputs[0].delegationId = 'attempt-1';
  assert.equal(passes(observation), false);
});

test('a partial result without an actual context notice cannot pass the handoff case', () => {
  const observation = completedHandoff();
  observation.notices = [];
  assert.equal(passes(observation), false);
});

test('an unpaired context notice cannot pass as a committed runtime notification', () => {
  const observation = completedHandoff();
  observation.notices[0].paired = false;
  assert.equal(passes(observation), false);
});

test('a model-call notice cannot substitute for the context watermark under evaluation', () => {
  const observation = completedHandoff();
  observation.notices[0].reason = 'model_calls';
  assert.equal(passes(observation), false);
});

test('a preparation notice cannot substitute for final context handoff', () => {
  const observation = completedHandoff();
  observation.notices[0].phase = 'prepare';
  assert.equal(passes(observation), false);
});

test('verification in the first delegation does not exercise continuation after the handoff', () => {
  const observation = completedHandoff();
  observation.toolCalls[1].delegationId = 'attempt-1';
  assert.equal(passes(observation), false);
});

for (const toolIndex of [0, 1]) {
  test(`tool observation ${toolIndex} must belong to the corresponding real delegation`, () => {
    const observation = completedHandoff();
    observation.toolCalls[toolIndex].delegationId = 'unrelated-attempt';
    assert.equal(passes(observation), false);
  });
}

test('continuation cannot pass by replaying private tool history', () => {
  const observation = completedHandoff();
  observation.continuationInputs[0].hasPrivateToolHistory = true;
  assert.equal(passes(observation), false);
});

test('continuation must actually receive the prior delivery', () => {
  const observation = completedHandoff();
  observation.continuationInputs[0].hasPriorDelivery = false;
  assert.equal(passes(observation), false);
});

test('an invocation error cannot pass because earlier observations look complete', () => {
  const observation = completedHandoff();
  observation.invocationError = 'provider failed after returning partial work';
  assert.equal(passes(observation), false);
});

test('a verbal verification claim requires a successful verify tool result', () => {
  const observation = completedHandoff();
  observation.toolCalls[1].success = false;
  assert.equal(passes(observation), false);
});

test('a complete lifecycle must deliver both observed fact identifiers to the user', () => {
  const observation = completedHandoff();
  observation.finalText = 'Only EVIDENCE-6429 is reported.';
  assert.equal(passes(observation), false);
});

test('below-watermark control completes in one delegation without a budget notice', () => {
  assert.equal(passes(completedControl(), controlExpected), true);
});

test('below-watermark control rejects an unnecessary context handoff', () => {
  const observation = completedControl();
  observation.notices = completedHandoff().notices;
  assert.equal(passes(observation, controlExpected), false);
});

test('below-watermark control rejects an unnecessary second delegation', () => {
  assert.equal(passes(completedHandoff(), controlExpected), false);
});
