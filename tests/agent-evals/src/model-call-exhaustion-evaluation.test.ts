import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  evaluateModelCallExhaustionInvariants,
  runModelCallExhaustionCase,
  type ModelCallExhaustionObservation,
} from './model-call-exhaustion-evaluation.ts';

function completed(): ModelCallExhaustionObservation {
  return {
    attempts: [
      { taskId: 'task', delegationId: 'first', maxIterations: 2, modelCallCount: 2,
        delivery: 'EVIDENCE-6429; opaque ticket; verification is unfinished.', guardStopReasons: ['subagent_iteration_limit_reached'] },
      { taskId: 'task', delegationId: 'second', maxIterations: 4, modelCallCount: 2,
        delivery: 'EVIDENCE-6429 and VERIFY-3817.', guardStopReasons: [] },
    ],
    toolCalls: [{ name: 'read_evidence', delegationId: 'first', success: true },
      { name: 'verify_evidence', delegationId: 'second', success: true }],
    notices: [{ reason: 'model_calls', phase: 'finalize', paired: true, delegationId: 'first' }],
    continuationInputs: [{ delegationId: 'second', hasPriorDelivery: true, hasPrivateToolHistory: false }],
    extraModelCallRequested: true, blockedIteration: 3, handoffTicketPreserved: true,
    finalText: 'EVIDENCE-6429 and VERIFY-3817.', invocationError: null,
  };
}

function passes(observation: ModelCallExhaustionObservation) {
  const invariants = evaluateModelCallExhaustionInvariants(observation);
  assert.ok(invariants.length > 0);
  return invariants.every(item => item.passed);
}

test('model-call exhaustion scoring accepts a blocked third request and fresh-child completion', () => {
  assert.equal(passes(completed()), true);
});

test('a repeated evidence read does not invalidate preserved results and completed continuation', () => {
  const observation = completed();
  observation.toolCalls.splice(1, 0, { name: 'read_evidence', delegationId: 'second', success: true });
  assert.equal(passes(observation), true);
});

for (const field of ['hasPriorDelivery', 'handoffTicketPreserved'] as const) {
  test(`repeated reading cannot replace ${field} in the continuation contract`, () => {
    const observation = completed();
    observation.toolCalls.splice(1, 0, { name: 'read_evidence', delegationId: 'second', success: true });
    if (field === 'hasPriorDelivery') observation.continuationInputs[0].hasPriorDelivery = false;
    else observation.handoffTicketPreserved = false;
    assert.equal(passes(observation), false);
  });
}

const invalidObservations: Array<[string, (observation: ModelCallExhaustionObservation) => void]> = [
  ['a third provider request was actually sent', observation => { observation.attempts[0].modelCallCount = 3; }],
  ['the real model stopped early before exhaustion', observation => { observation.attempts[0].modelCallCount = 1; }],
  ['no extra model entry was requested', observation => { observation.extraModelCallRequested = false; }],
  ['the native guard did not block the requested third entry', observation => { observation.blockedIteration = null; }],
  ['only a context guard stopped execution', observation => { observation.attempts[0].guardStopReasons = ['subagent_context_limit_reached']; }],
  ['a guard message replaced the actual handoff', observation => { observation.attempts[0].delivery = null; }],
  ['the ticket was lost', observation => { observation.handoffTicketPreserved = false; }],
  ['the evidence fact was lost', observation => { observation.attempts[0].delivery = 'Unfinished work.'; }],
  ['the first child executed verification after its budget ran out', observation => { observation.toolCalls[1].delegationId = 'first'; }],
  ['no actual verification succeeded', observation => { observation.toolCalls[1].success = false; }],
  ['a tool observation has no matching real attempt', observation => { observation.toolCalls.push({ name: 'read_evidence', delegationId: 'unknown', success: true }); }],
  ['the notice was not paired and persisted', observation => { observation.notices[0].paired = false; }],
  ['only a preparation notice was delivered', observation => { observation.notices[0].phase = 'prepare'; }],
  ['the first child had no notice', observation => { observation.notices = []; }],
  ['the child received a context notice instead of a call-budget notice', observation => { observation.notices[0].reason = 'context_window'; }],
  ['the next attempt has a different task', observation => { observation.attempts[1].taskId = 'replacement'; }],
  ['the same delegation identity was reused', observation => { observation.attempts[1].delegationId = 'first'; }],
  ['a continuation with no task identity was accepted', observation => { observation.attempts.forEach(attempt => { attempt.taskId = ''; }); }],
  ['the prior delivery was absent from the actual model input', observation => { observation.continuationInputs[0].hasPriorDelivery = false; }],
  ['private tool history was replayed', observation => { observation.continuationInputs[0].hasPrivateToolHistory = true; }],
  ['the fresh attempt also exhausted its budget', observation => { observation.attempts[1].guardStopReasons = ['subagent_iteration_limit_reached']; }],
  ['the fresh attempt exceeded its own model-call budget', observation => { observation.attempts[1].modelCallCount = 5; }],
  ['the final reply omitted the verification fact', observation => { observation.finalText = 'EVIDENCE-6429.'; }],
  ['an invocation error was ignored', observation => { observation.invocationError = 'provider unavailable'; }],
];
for (const [reason, mutate] of invalidObservations) {
  test(`model-call exhaustion scoring rejects when ${reason}`, () => {
    const observation = completed();
    mutate(observation);
    assert.equal(passes(observation), false);
  });
}

class EvidenceModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly rereadInContinuation = false) { super({}); }
  _llmType() { return 'native-call-exhaustion-fixture'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    const turn = this.inputs.length;
    let message: AIMessage;
    if (turn === 1) {
      message = new AIMessage({ content: '', tool_calls: [{ id: 'read', name: 'read_evidence', args: {} }] });
    } else if (turn === 2) {
      const evidence = messages.find(item => ToolMessage.isInstance(item) && item.name === 'read_evidence');
      assert.ok(evidence);
      const ticket = evidence.text.match(/ticket-[\w-]+/)?.[0];
      assert.ok(ticket);
      message = new AIMessage(`Read EVIDENCE-6429. Ticket ${ticket}; verification is unfinished. Continue by actually calling verify_evidence with that ticket.`);
    } else if (turn === 3) {
      assert.ok(messages.every(item => !ToolMessage.isInstance(item)), 'the fresh invocation must not replay the old private tool transcript');
      const ticket = messages.filter(AIMessage.isInstance).map(item => item.text).join('\n').match(/ticket-[\w-]+/)?.[0];
      assert.ok(ticket, 'the real handoff must carry the opaque tool ticket');
      message = this.rereadInContinuation
        ? new AIMessage({ content: '', tool_calls: [{ id: 'reread', name: 'read_evidence', args: {} }] })
        : new AIMessage({ content: '', tool_calls: [{ id: 'verify', name: 'verify_evidence', args: { ticket } }] });
    } else if (this.rereadInContinuation && turn === 4) {
      const ticket = messages.filter(AIMessage.isInstance).map(item => item.text).join('\n').match(/ticket-[\w-]+/)?.[0];
      assert.ok(ticket, 'a repeated read must not erase the original handoff');
      message = new AIMessage({ content: '', tool_calls: [{ id: 'verify', name: 'verify_evidence', args: { ticket } }] });
    } else {
      assert.equal(turn, this.rereadInContinuation ? 5 : 4, 'the forced exhausted entry must not become a provider invocation');
      assert.ok(messages.some(item => ToolMessage.isInstance(item) && item.name === 'verify_evidence' && item.text.includes('VERIFY-3817')));
      message = new AIMessage('Observed EVIDENCE-6429 and actually verified VERIFY-3817.');
    }
    return { generations: [{ message, text: message.text }] };
  }
}

test('the production child counter blocks an extra model entry without losing its actual handoff', async () => {
  const model = new EvidenceModel();
  const executed = await runModelCallExhaustionCase({ input: { userMessage: 'Read evidence and actually verify it.' }, model });
  assert.equal(executed.observation.invocationError, null);
  assert.deepEqual(evaluateModelCallExhaustionInvariants(executed.observation).filter(item => !item.passed), [], JSON.stringify(executed.observation));
  assert.equal(model.inputs.length, 4);
  assert.deepEqual(executed.observation.attempts.map(attempt => attempt.modelCallCount), [2, 2]);
  assert.deepEqual(executed.observation.toolCalls.map(call => call.name), ['read_evidence', 'verify_evidence']);
  assert.equal(executed.diagnostics.completedDelegations, 2);
  assert.equal(executed.diagnostics.modelCallCount, 4);
  assert.deepEqual(executed.diagnostics.efficiency, { readCalls: 1, repeatedReadCalls: 0 });
});

test('a fresh child may reread while preserving the native budget and useful prior delivery', async () => {
  const model = new EvidenceModel(true);
  const executed = await runModelCallExhaustionCase({ input: { userMessage: 'Read evidence and actually verify it.' }, model });
  assert.equal(executed.observation.invocationError, null);
  assert.deepEqual(evaluateModelCallExhaustionInvariants(executed.observation).filter(item => !item.passed), [], JSON.stringify(executed.observation));
  assert.deepEqual(executed.observation.attempts.map(attempt => attempt.modelCallCount), [2, 3]);
  assert.deepEqual(executed.observation.toolCalls.map(call => call.name), ['read_evidence', 'read_evidence', 'verify_evidence']);
  assert.equal(model.inputs.length, 5, 'the blocked third entry of the first child is not a provider call');
  assert.deepEqual(executed.diagnostics.efficiency, { readCalls: 2, repeatedReadCalls: 1 });
});
