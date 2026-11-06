import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { isDelegationBriefingMessage } from '../../../packages/pet-agent/src/agent/orchestrator/delegation/briefing.ts';
import { evaluateBudgetHandoffInvariants, runBudgetHandoffCase } from './budget-handoff-evaluation.ts';
import { budgetHandoffDataset } from './datasets/budget-handoff.ts';

const originalBriefing = 'Read the evidence and actually verify it. Keep the original task scope.\nPreserve status="pending" and the diagnostic boundary ]]>.';

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

class ContinuationModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  _llmType() { return 'budget-continuation-probe'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const turn = this.inputs.push([...messages]) - 1;
    let message: AIMessage;
    switch (turn) {
      case 0:
        message = call('plan_request', { goal: 'Read the evidence and actually verify it.' }, 'request');
        break;
      case 1:
        message = call('submit_plan', { tasks: [{ capability: 'general', objective: 'Read and verify the evidence.' }] }, 'plan');
        break;
      case 2:
        message = call('delegate_capability', { briefing: originalBriefing }, 'first');
        break;
      case 3:
        message = call('read_evidence', {}, 'read');
        break;
      case 4: {
        const report = messages.find(item => ToolMessage.isInstance(item) && item.name === 'read_evidence');
        const ticket = report?.text.match(/Verification ticket: (\S+)/)?.[1];
        assert.ok(ticket, 'the partial delivery must use the actual private tool result');
        message = new AIMessage(`EVIDENCE-6429. Verification ticket: ${ticket}\nVerification has not run; use the ticket to complete it.`);
        break;
      }
      case 5:
        message = call('review_current', { completed: false, reason: 'Evidence read; verification remains.' }, 'partial');
        break;
      case 6:
        message = call('delegate_capability', { continue: true }, 'second');
        break;
      case 7: {
        const result = messages.find(item => ToolMessage.isInstance(item) && item.name === 'delegate_capability');
        const delivered = result ? JSON.parse(result.text).delivery?.text : '';
        const ticket = delivered.match(/Verification ticket: (\S+)/)?.[1];
        assert.ok(ticket, 'the fresh executor must receive the ticket through the actual prior delivery');
        message = call('verify_evidence', { ticket }, 'verify');
        break;
      }
      case 8:
        message = new AIMessage('EVIDENCE-6429 was actually verified: VERIFY-3817.');
        break;
      case 9:
        message = call('review_current', { completed: true, reason: 'Actual verification completed.' }, 'accept');
        break;
      case 10:
        message = new AIMessage('EVIDENCE-6429 confirmed by actual verification VERIFY-3817.');
        break;
      default:
        throw new Error(`Unexpected model turn ${turn}`);
    }
    return { generations: [{ message, text: message.text }] };
  }
}

test('production budget continuation reuses the briefing while transporting runtime background and prior delivery', async () => {
  const testCase = budgetHandoffDataset.cases.find(item => item.name === 'context-window-handoff')!;
  const model = new ContinuationModel({});
  const result = await runBudgetHandoffCase({ input: testCase.input, model });
  assert.equal(result.observation.invocationError, null);
  assert.deepEqual(evaluateBudgetHandoffInvariants(result.observation, testCase.expected).filter(item => !item.passed), []);
  assert.deepEqual(result.diagnostics.delegationBriefings.map(item => item.request), [
    { briefing: originalBriefing }, { continue: true },
  ]);
  assert.deepEqual(result.diagnostics.delegationBriefings.map(item => item.briefing), [originalBriefing, originalBriefing]);
  const [first, second] = result.observation.executions;
  assert.deepEqual(second.continuation, { delegationId: first.delegationId, deliveryId: first.deliveryId });
  assert.equal(result.observation.continuationInputs[1].continuationMatches, true);
  assert.equal(result.observation.continuationInputs[1].hasPriorDelivery, true);
  assert.equal(result.observation.continuationInputs[1].hasPrivateToolHistory, false);
  assert.deepEqual(result.observation.toolCalls.map(item => item.name), ['read_evidence', 'verify_evidence']);
  assert.equal(result.observation.executions.length, 2);
  assert.notEqual(first.delegationId, second.delegationId);
  assert.equal(model.inputs[7].filter(isDelegationBriefingMessage).length, 1);
});
