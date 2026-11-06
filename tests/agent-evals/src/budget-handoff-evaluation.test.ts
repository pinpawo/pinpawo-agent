import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { markSubagentGuardStop } from '../../../packages/pet-agent/src/subagent/guardStop.ts';
import {
  evaluateBudgetHandoffInvariants,
  readCheckpointGuardStops,
  type BudgetHandoffObservation,
} from './budget-handoff-evaluation.ts';
import { budgetHandoffDataset } from './datasets/budget-handoff.ts';

const handoffExpected = budgetHandoffDataset.cases.find(({ name }) => name === 'context-window-handoff')!.expected;
const controlExpected = budgetHandoffDataset.cases.find(({ name }) => name === 'below-watermark-control')!.expected;
const overflowExpected = budgetHandoffDataset.cases.find(({ name }) => name === 'context-already-exceeded')!.expected;
const verbatimCase = budgetHandoffDataset.cases.find(({ name }) => name === 'goal-results-verbatim')!;

test('checkpoint guard scope survives reuse of a provider tool-call ID in a fresh delegation', () => {
  const scopes = new Map([['result-first', 'attempt-first'], ['result-second', 'attempt-second']]);
  for (const suffix of ['first', 'second']) {
    const result = new ToolMessage({ id: `result-${suffix}`, content: 'evidence', name: 'read_evidence', tool_call_id: 'reused-call-id' });
    const stop = markSubagentGuardStop(new AIMessage({ id: `stop-${suffix}`, content: 'guard stop' }), 'subagent_context_limit_reached');
    assert.deepEqual(readCheckpointGuardStops([result, stop], scopes), [{
      id: `stop-${suffix}`, reason: 'subagent_context_limit_reached', delegationId: `attempt-${suffix}`,
    }]);
  }
});

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
    continuationInputs: [{ delegationId: 'attempt-2', hasPriorResult: true, hasPriorDelivery: true, hasPrivateToolHistory: false }],
    guardStops: [],
    childModelCalls: [{ delegationId: 'attempt-1', count: 2 }, { delegationId: 'attempt-2', count: 2 }],
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
  observation.childModelCalls = [{ delegationId: 'attempt-1', count: 3 }];
  return observation;
}

function completedOverflowRecovery(): BudgetHandoffObservation {
  const observation = completedHandoff();
  observation.executions[0].status = 'missing_deliverable';
  observation.executions[0].delivery = null;
  observation.toolCalls.splice(1, 0, { name: 'read_evidence', delegationId: 'attempt-2', success: true });
  observation.notices = [];
  observation.guardStops = [{ reason: 'subagent_context_limit_reached', delegationId: 'attempt-1' }];
  observation.childModelCalls = [{ delegationId: 'attempt-1', count: 1 }, { delegationId: 'attempt-2', count: 3 }];
  observation.continuationInputs[0].hasPriorDelivery = false;
  return observation;
}

function completedVerbatimResults(): BudgetHandoffObservation {
  const observation = completedHandoff();
  const original = verbatimCase.expected.verbatimResult!;
  observation.verbatimEvidence = { source: 'evidence-fixture.ts', text: original };
  observation.executions[0].delivery += `\nSource: evidence-fixture.ts\n\`\`\`text\n${original}\n\`\`\``;
  observation.finalText += `\nSource: evidence-fixture.ts\n\`\`\`text\n${original}\n\`\`\``;
  return observation;
}

function passes(observation: BudgetHandoffObservation, expected = handoffExpected): boolean {
  const invariants = evaluateBudgetHandoffInvariants(observation, expected);
  assert.ok(invariants.length > 0, 'the eval must have mechanical acceptance checks');
  return invariants.every(({ passed }) => passed);
}

test('budget handoff dataset has executable identities, mechanical expectations and semantic acceptance criteria', () => {
  const cases = budgetHandoffDataset.cases;
  assert.equal(cases.length, 5);
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  assert.deepEqual(cases.map(({ expected }) => expected.contextHandoff), [true, false, false, false, true]);
  assert.deepEqual(cases.map(({ expected }) => expected.expectedDelegations), [2, 2, 2, 1, 2]);
  const overflowCase = cases.find(({ name }) => name === 'context-already-exceeded')!;
  const callBudgetCase = cases.find(({ name }) => name === 'model-call-budget-exhausted')!;
  assert.equal(overflowCase.input.scenario, 'context-overflow');
  assert.equal(overflowCase.expected.contextOverflow, true);
  assert.equal(callBudgetCase.input.scenario, 'model-call-exhausted');
  assert.notEqual(callBudgetCase.expected.contextOverflow, true);
  for (const { input, expected } of cases) {
    assert.equal(input.contextWindowTokens, 16_000);
    assert.equal(input.generationReserveTokens, 0);
    assert.ok(input.reportChars > 0);
    const criterionIds = expected.acceptanceCriteria.map(({ id }) => id);
    assert.ok(criterionIds.length > 0);
    assert.equal(new Set(criterionIds).size, criterionIds.length);
  }
  const controlCase = cases.find(({ name }) => name === 'below-watermark-control')!;
  assert.ok(overflowCase.input.reportChars > cases[0].input.reportChars);
  assert.ok(cases[0].input.reportChars > controlCase.input.reportChars);
  assert.ok(verbatimCase.input.requiredVerbatimText);
  assert.equal(verbatimCase.input.requiredVerbatimText, verbatimCase.expected.verbatimResult);
  assert.ok(verbatimCase.input.requiredVerbatimText.includes('\n'));
  assert.equal(verbatimCase.input.userMessage.includes(verbatimCase.input.requiredVerbatimText), false,
    'the exact diagnostic must come from the evidence tool, not be leaked in the task');
});

test('goal-related results retain the complete sourced original in delivery and final reply', () => {
  assert.equal(passes(completedVerbatimResults(), verbatimCase.expected), true);
});

test('Markdown blockquote markers do not invalidate an otherwise exact original quotation', () => {
  const observation = completedVerbatimResults();
  const original = verbatimCase.expected.verbatimResult!;
  const quote = original.split('\n').map(line => `> ${line}`).join('\n');
  observation.executions[0].delivery = observation.executions[0].delivery!.replace(original, quote);
  observation.finalText = observation.finalText.replace(original, quote);
  assert.equal(passes(observation, verbatimCase.expected), true);
});

for (const [name, change] of [
  ['a changed fact value', (text: string) => text.replace('pending', 'ready')],
  ['a missing second line', (text: string) => text.split('\n')[0]],
  ['typographic quotes replacing original ASCII quotes', (text: string) => text.replaceAll('"', '“')],
  ['literal backslash-n replacing the original line break', (text: string) => text.replace('\n', '\\n')],
  ['extra whitespace inside the original', (text: string) => text.replace('expected status', 'expected  status')],
] as const) {
  for (const output of ['first-delivery', 'final-reply'] as const) {
    test(`verbatim results reject ${name} in the ${output}`, () => {
      const observation = completedVerbatimResults();
      const original = verbatimCase.expected.verbatimResult!;
      if (output === 'first-delivery') observation.executions[0].delivery = observation.executions[0].delivery!.replace(original, change(original));
      else observation.finalText = observation.finalText.replace(original, change(original));
      assert.equal(passes(observation, verbatimCase.expected), false);
    });
  }
}

test('verbatim results require the original to have been observed from the evidence source', () => {
  const observation = completedVerbatimResults();
  delete observation.verbatimEvidence;
  assert.equal(passes(observation, verbatimCase.expected), false);
});

test('an empty verbatim requirement cannot pass through vacuous substring matching', () => {
  assert.equal(passes(completedVerbatimResults(), { ...verbatimCase.expected, verbatimResult: '' }), false);
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

test('already-exceeded context accepts a guarded missing delivery followed by same-task recovery', () => {
  assert.equal(passes(completedOverflowRecovery(), overflowExpected), true);
});

const invalidOverflowObservations: Array<{
  name: string;
  mutate: (observation: BudgetHandoffObservation) => void;
}> = [
  { name: 'an invocation failure', mutate: observation => { observation.invocationError = 'provider failed'; } },
  { name: 'a fabricated first delivery', mutate: observation => { observation.executions[0].delivery = 'Invented handoff'; } },
  { name: 'a claimed successful first attempt', mutate: observation => { observation.executions[0].status = 'returned'; } },
  { name: 'an unguarded missing delivery', mutate: observation => { observation.guardStops = []; } },
  { name: 'a second provider request after overflow', mutate: observation => { observation.childModelCalls[0].count = 2; } },
  { name: 'missing provider-call evidence', mutate: observation => { observation.childModelCalls = []; } },
  { name: 'an unrelated stop reason', mutate: observation => { observation.guardStops[0].reason = 'subagent_iteration_limit_reached'; } },
  { name: 'a guard from another delegation', mutate: observation => { observation.guardStops[0].delegationId = 'unrelated-attempt'; } },
  { name: 'an unscoped guard', mutate: observation => { observation.guardStops[0].delegationId = null; } },
  { name: 'an extra hard stop', mutate: observation => { observation.guardStops.push({ ...observation.guardStops[0] }); } },
  { name: 'replayed private tool history', mutate: observation => { observation.continuationInputs[0].hasPrivateToolHistory = true; } },
  { name: 'a continuation with no prior execution result', mutate: observation => { observation.continuationInputs[0].hasPriorResult = false; } },
  { name: 'a fabricated valid prior delivery', mutate: observation => { observation.continuationInputs[0].hasPriorDelivery = true; } },
  { name: 'recovery without rereading evidence', mutate: observation => { observation.toolCalls.splice(1, 1); } },
  { name: 'a failed evidence reread', mutate: observation => { observation.toolCalls[1].success = false; } },
  { name: 'a reread attributed to the failed attempt', mutate: observation => { observation.toolCalls[1].delegationId = 'attempt-1'; } },
  { name: 'verification in the failed attempt', mutate: observation => { observation.toolCalls[2].delegationId = 'attempt-1'; } },
  { name: 'a notice presented as a successful handoff', mutate: observation => { observation.notices = completedHandoff().notices; } },
  { name: 'a new task replacing the original', mutate: observation => { observation.executions[1].taskId = 'replacement-task'; } },
  { name: 'an unfinished recovery plan', mutate: observation => { observation.planCompleted = false; } },
];

for (const { name, mutate } of invalidOverflowObservations) {
  test(`already-exceeded context recovery rejects ${name}`, () => {
    const observation = completedOverflowRecovery();
    mutate(observation);
    assert.equal(passes(observation, overflowExpected), false);
  });
}

test('a hard context stop cannot substitute for a successful near-watermark handoff', () => {
  const observation = completedHandoff();
  observation.guardStops = completedOverflowRecovery().guardStops;
  assert.equal(passes(observation), false);
});
