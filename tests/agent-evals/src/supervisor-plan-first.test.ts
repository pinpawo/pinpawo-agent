import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildRunSupervisorAgentSystemPrompt, buildRunSupervisorTurnInput } from '../../../packages/pet-agent/src/agent/orchestrator/prompts/runSupervisorAgent';
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

test('zero prior runs keeps only the scenario-specific run', () => {
  for (const scenario of planFirstScenarios(0)) {
    assert.equal(scenario.prior.length, scenario.name === 'new-unrelated-request' ? 0 : 1, scenario.name);
  }
  assert.equal(planFirstScenarios(16).find((s) => s.name === 'similar-follow-up')!.prior.length, 17);
});

test('plan scenarios pass only when submit_plan is the first control decision', () => {
  assert.equal(scorePlanFirst([{ name: 'submit_plan' }, { name: 'delegate_capability' }]).passed, true);
  assert.equal(scorePlanFirst([{ name: 'capability_details' }, { name: 'submit_plan' }]).passed, true);
  assert.deepEqual(scorePlanFirst([{ name: 'delegate_capability' }, { name: 'submit_plan' }]),
    { passed: false, first: 'delegate_capability', delegatedBeforePlan: true });
  assert.deepEqual(scorePlanFirst([]), { passed: false, first: 'none', delegatedBeforePlan: false });
});

test('ask scenarios pass when nothing is delegated', () => {
  assert.equal(scorePlanFirst([], 'ask').passed, true);
  assert.equal(scorePlanFirst([{ name: 'submit_plan' }], 'ask').passed, true);
  assert.equal(scorePlanFirst([{ name: 'submit_plan' }, { name: 'delegate_capability' }], 'ask').passed, false);
});

test('baselines swap exactly the shipped Entry guidance or invocation', () => {
  const role = new SystemMessage({ content: [{ type: 'text', text: buildRunSupervisorAgentSystemPrompt('entry') }] });
  const scenario = planFirstScenarios(0)[0];
  const turn = new HumanMessage(buildRunSupervisorTurnInput(planFirstInput(scenario, 'baseline')));
  assert.match(turn.content as string, /This run has no plan yet/);
  const [keptRole, systemOnlyTurn] = withGuidance([role, turn], 'systemOnly');
  assert.equal(keptRole, role);
  assert.doesNotMatch(systemOnlyTurn.content as string, /This run has no plan yet/);
  assert.match(systemOnlyTurn.content as string, /Interpret the user request before submitting the execution plan\./);
  const [previousRole, previousTurn] = withGuidance([role, turn], 'previous');
  const text = JSON.stringify(previousRole.content);
  assert.equal(text.includes('只执行本 run 计划中的下一项'), false);
  assert.equal(text.includes('通过 submit_plan 建立计划'), true);
  assert.deepEqual(previousTurn.content, systemOnlyTurn.content);
  assert.deepEqual(withGuidance([role, turn], 'current'), [role, turn]);
  assert.throws(() => withGuidance([turn], 'previous'), /update the A\/B baselines/);
});
