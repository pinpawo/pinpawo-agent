import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { closureInput, scoreClosure } from './supervisor-delivery-closure';
import { supervisorDeliveryClosureDataset } from './datasets/supervisor-delivery-closure';
import { createSupervisorMessageHandoff } from '../src/agent/orchestrator/runSupervisor/messageHandoff';
import { supervisorHandoffContext } from '../src/agent/orchestrator/runSupervisor/input';

function control(name: string, args: Record<string, unknown>) {
  return [new AIMessage({ content: '', tool_calls: [{ name, args, id: name, type: 'tool_call' }] }),
    new ToolMessage({ name, tool_call_id: name, content: 'Accepted' })];
}
const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === 'review-text-is-not-submission')!;
test('a completion claim without reporting fails the outcome evaluator', () => {
  const input = closureInput(example.input, 'false-completion');
  const reply = 'The review is saved to the board. Done.';
  const messages = createSupervisorMessageHandoff(supervisorHandoffContext(input), [
    ...control('review_current', { completed: true, reason: 'Review text accepted.' }), new AIMessage(reply),
  ]);
  assert.equal(scoreClosure(input, { messages, reply, capabilityDisclosure: input.capabilityDisclosure }, example.expected).passed, false);
});
test('actual reporting handoff passes regardless of natural-language wording', () => {
  const input = closureInput(example.input, 'reporting');
  const messages = createSupervisorMessageHandoff(supervisorHandoffContext(input), [
    ...control('review_current', { completed: true, reason: 'Review content is complete.' }),
    ...control('adjust_plan', { goal: input.userRequest, reason: 'Submission remains.', currentDelegation: 'replace', tasks: [{ capability: 'studio_reporting', task: 'Submit the complete review.' }] }),
    ...control('delegate_capability', {}),
  ]);
  assert.equal(scoreClosure(input, { messages, capabilityDisclosure: input.capabilityDisclosure }, example.expected).passed, true);
});
test('negative controls allow ending without introducing reporting work', () => {
  for (const name of ['review-only', 'already-submitted']) {
    const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === name)!;
    const input = closureInput(example.input, name);
    const reply = 'Complete.';
    const messages = createSupervisorMessageHandoff(supervisorHandoffContext(input), [
      ...control('review_current', { completed: true, reason: 'Requested result is evidenced.' }), new AIMessage(reply),
    ]);
    assert.equal(scoreClosure(input, { messages, reply, capabilityDisclosure: input.capabilityDisclosure }, example.expected).passed, true);
  }
});

test('gratuitous replanning fails even when the final reporting capability is correct', () => {
  const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === 'pending-report')!;
  const input = closureInput(example.input, 'gratuitous-adjustment');
  const messages = createSupervisorMessageHandoff(supervisorHandoffContext(input), [
    ...control('review_current', { completed: true, reason: 'Review content is complete.' }),
    ...control('adjust_plan', { goal: input.userRequest, reason: 'Restate the existing pending task.', currentDelegation: 'replace', tasks: [{ capability: 'studio_reporting', task: 'Submit the complete review.' }] }),
    ...control('delegate_capability', {}),
  ]);
  const score = scoreClosure(input, { messages, capabilityDisclosure: input.capabilityDisclosure }, example.expected);
  assert.equal(score.actual, 'report');
  assert.equal(score.adjustments, 1);
  assert.equal(score.passed, false);
});

test('a rejected adjustment followed by correction counts as one actual plan change', () => {
  const input = closureInput(example.input, 'corrected-adjustment');
  const args = { goal: input.userRequest, reason: 'Submission remains.', currentDelegation: 'replace',
    tasks: [{ capability: 'studio_reporting', task: 'Submit the complete review.' }] };
  const rejected = control('adjust_plan', { ...args, tasks: [{ ...args.tasks[0], id: 'invented' }] });
  (rejected[0] as AIMessage).tool_calls![0].id = 'bad-adjust';
  rejected[1] = new ToolMessage({ name: 'adjust_plan', tool_call_id: 'bad-adjust', status: 'error', content: 'Unexpected id.' });
  const messages = createSupervisorMessageHandoff(supervisorHandoffContext(input), [
    ...control('review_current', { completed: true, reason: 'Review returned.' }),
    ...rejected, ...control('adjust_plan', args), ...control('delegate_capability', {}),
  ]);
  const score = scoreClosure(input, { messages, capabilityDisclosure: input.capabilityDisclosure }, example.expected);
  assert.equal(score.passed, true);
  assert.equal(score.adjustments, 1);
  assert.equal(score.adjustmentAttempts, 2);
});
