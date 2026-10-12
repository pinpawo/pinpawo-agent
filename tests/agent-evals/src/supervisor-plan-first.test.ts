import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { buildRunSupervisorAgentSystemPrompt } from '../../../packages/pet-agent/src/agent/orchestrator/prompts/runSupervisorAgent';
import { planFirstInput, planFirstScenarios, scorePlanFirst, withGuidance } from './supervisor-plan-first';

test('fixture reproduces main history: plan_request then delegate per earlier run, no submit_plan', () => {
  for (const scenario of planFirstScenarios(3)) {
    const input = planFirstInput(scenario, `fixture-${scenario.name}`);
    const calls = input.messages.flatMap((m) => AIMessage.isInstance(m) ? m.tool_calls ?? [] : []).map((c) => c.name);
    const runs = scenario.prior.length;
    assert.equal(calls.filter((name) => name === 'plan_request').length, runs + 1);
    assert.equal(calls.filter((name) => name === 'delegate_capability').length, runs);
    assert.equal(calls.includes('submit_plan'), false);
    assert.deepEqual(calls.slice(0, 2), ['plan_request', 'delegate_capability']);
    assert.equal(calls.at(-1), 'plan_request');
    assert.equal(input.mode, 'entry');
    assert.deepEqual(input.state, { runId: null, goal: null, plan: [] });
  }
});

test('zero prior runs keeps only the current request, except where the scenario needs one', () => {
  const [unrelated, similar, confirm] = planFirstScenarios(0);
  assert.equal(unrelated.prior.length, 0);
  assert.equal(similar.prior.length, 1);
  assert.equal(confirm.prior.length, 1);
});

test('score passes only when submit_plan is the first control decision', () => {
  assert.equal(scorePlanFirst([{ name: 'submit_plan' }, { name: 'delegate_capability' }]).passed, true);
  assert.equal(scorePlanFirst([{ name: 'capability_details' }, { name: 'submit_plan' }]).passed, true);
  assert.deepEqual(scorePlanFirst([{ name: 'delegate_capability' }, { name: 'submit_plan' }]),
    { passed: false, first: 'delegate_capability', delegatedBeforePlan: true });
  assert.deepEqual(scorePlanFirst([]), { passed: false, first: 'none', delegatedBeforePlan: false });
});

test('previous-guidance baseline swaps exactly the shipped Entry guidance', () => {
  const role = new SystemMessage({ content: [{ type: 'text', text: buildRunSupervisorAgentSystemPrompt('entry') }] });
  const [swapped] = withGuidance([role], 'previous');
  const text = JSON.stringify(swapped.content);
  assert.equal(text.includes('不表示本 run 可以跳过 submit_plan'), false);
  assert.equal(text.includes('通过 submit_plan 建立计划'), true);
  assert.equal(withGuidance([role], 'current')[0], role);
});
