import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { closureInput, scoreClosure } from './supervisor-delivery-closure';
import { supervisorDeliveryClosureDataset } from './datasets/supervisor-delivery-closure';
import { scriptedSupervisorSequence } from '../src/agent/orchestrator/runSupervisor/testing';
import type { ScriptedSupervisorControl } from '../src/agent/orchestrator/runSupervisor/testing';

const review: ScriptedSupervisorControl = { name: 'review_current', args: { completed: true, reason: 'Review content is complete.' } };
const delegate: ScriptedSupervisorControl = { name: 'delegate_capability', args: { briefing: 'Execute the current objective.' } };
const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === 'review-text-is-not-submission')!;
function adjustment(goal: string): ScriptedSupervisorControl {
  return { name: 'adjust_plan', args: { goal, reason: 'Submission remains.', currentTask: 'replace',
    tasks: [{ capability: 'studio_reporting', objective: 'Submit the complete review.' }] } };
}

test('a completion claim without reporting fails the outcome evaluator', () => {
  const input = closureInput(example.input, 'false-completion');
  const result = scriptedSupervisorSequence(input, [review, { reply: 'The review is saved to the board. Done.' }]);
  assert.equal(scoreClosure(input, result, example.expected).passed, false);
});
test('actual reporting handoff passes regardless of natural-language wording', () => {
  const input = closureInput(example.input, 'reporting');
  const result = scriptedSupervisorSequence(input, [review, adjustment(input.userRequest), delegate]);
  assert.equal(scoreClosure(input, result, example.expected).passed, true);
});
test('negative controls allow ending without introducing reporting work', () => {
  for (const name of ['review-only', 'already-submitted']) {
    const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === name)!;
    const input = closureInput(example.input, name);
    const result = scriptedSupervisorSequence(input, [review, { reply: 'Complete.' }]);
    assert.equal(scoreClosure(input, result, example.expected).passed, true);
  }
});
test('gratuitous replanning fails even when the final reporting capability is correct', () => {
  const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === 'pending-report')!;
  const input = closureInput(example.input, 'gratuitous-adjustment');
  const result = scriptedSupervisorSequence(input, [review, adjustment(input.userRequest), delegate]);
  const score = scoreClosure(input, result, example.expected);
  assert.equal(score.actual, 'report');
  assert.equal(score.adjustments, 1);
  assert.equal(score.passed, false);
});
test('a rejected adjustment followed by correction counts as one actual plan change', () => {
  const input = closureInput(example.input, 'corrected-adjustment');
  const result = scriptedSupervisorSequence(input, [review, adjustment(input.userRequest), delegate]);
  const rejected = [
    new AIMessage({ content: '', tool_calls: [{ name: 'adjust_plan', id: 'bad-adjust', args: { taskId: 'invented' } }] }),
    new ToolMessage({ name: 'adjust_plan', tool_call_id: 'bad-adjust', status: 'error', content: 'Unexpected taskId.' }),
  ];
  const score = scoreClosure(input, { ...result, messages: [...rejected, ...result.messages] }, example.expected);
  assert.equal(score.passed, true);
  assert.equal(score.adjustments, 1);
  assert.equal(score.adjustmentAttempts, 2);
});
