import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { readCapabilityExecutions } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts';
import { parseSupervisorControl } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing.ts';
import { studioPetRoleCases, type StudioPetRoleCase } from './datasets/studio-pet-roles.ts';
import { buildStudioPetBoundaryInput, defaultStudioPetTemplateRoot, loadStudioPetRoleContext, runStudioPetRoleCase, StudioPetRoleInvocationError } from './studio-pet-role-evaluation.ts';
import type { StudioPetModelObservation } from './studio-pet-model-observer.ts';
import type { PromptEvalJudge } from './prompt-goal-evaluator.ts';
import { channelDispatchInput } from '../../support/channelDispatchInput.ts';
import { studioPetEvalChannelId } from './studio-pet-invocation-fixture.ts';

class ScriptedModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'studio-role-harness-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    const message = this.responses.shift();
    if (!message) throw new Error('Unexpected model call: this suite must not execute a Capability.');
    return { generations: [{ message, text: message.text }] };
  }
}

function call(name: string, args: Record<string, unknown>) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id: randomUUID(), type: 'tool_call' }] });
}

// Script the judge transport, not semantic acceptance. These tests check that
// the entire candidate and every criterion reaches a judge and affects scores.
function recordingJudge(failedId?: string) {
  const received: Array<Record<string, any>> = [];
  const judge: PromptEvalJudge = { model: {
    withStructuredOutput: () => ({ invoke: async (messages: BaseMessage[]) => {
      const payload = JSON.parse(messages.at(-1)!.text);
      received.push(payload);
      return { criteria: Object.fromEntries(payload.acceptanceCriteria.map(({ id }: { id: string }) => [id,
        { met: id !== failedId, reason: 'Scripted judge transport result.' }])), summary: 'Harness fixture, not a semantic model verdict.' };
    } }),
  } as never };
  return { judge, received };
}

function example(role: StudioPetRoleCase['role'], phase: StudioPetRoleCase['phase']) {
  return studioPetRoleCases.find(item => item.role === role && item.phase === phase)!;
}

test('each Pet has decision and continuous-flow cases with unique semantic criteria', async () => {
  assert.equal(new Set(studioPetRoleCases.map(item => item.id)).size, studioPetRoleCases.length);
  for (const role of ['issuer', 'executor', 'reviewer', 'wiki'] as const) {
    assert.deepEqual([...new Set(studioPetRoleCases.filter(item => item.role === role).map(item => item.phase))].sort(), ['boundary', 'entry', 'flow']);
    const context = await loadStudioPetRoleContext(role);
    assert.equal(context.registry.unavailableCapabilities.length, 0);
    assert.ok(context.catalog.capabilityNames.includes(context.config.defaultCapabilityName));
    for (const testCase of studioPetRoleCases.filter(item => item.role === role)) {
      assert.ok(testCase.expected.criteria.length >= 3);
      assert.equal(new Set(testCase.expected.criteria.map(item => item.id)).size, testCase.expected.criteria.length);
      for (const capability of testCase.expected.allowedCapabilities) assert.ok(context.catalog.capabilityNames.includes(capability));
      assert.equal(Boolean(testCase.boundary), testCase.phase === 'boundary');
      assert.equal(Boolean(testCase.flow), testCase.phase === 'flow');
      const usedToolkits = new Set(context.registry.capabilities.flatMap(item => item.capability.uses));
      assert.ok(context.registry.toolkits.filter(item => usedToolkits.has(item.name)).every(item => item.tools.length === 0));
    }
  }
});

test('template assembly honors explicit shared references and fails on missing references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-role-templates-'));
  try {
    await cp(defaultStudioPetTemplateRoot, root, { recursive: true });
    const path = join(root, 'pets', 'issuer.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    const original = await loadStudioPetRoleContext('issuer', root);
    await writeFile(path, JSON.stringify({ ...config, sharedCapabilities: [] }));
    const withoutShared = await loadStudioPetRoleContext('issuer', root);
    assert.deepEqual(withoutShared.catalog.capabilityNames,
      original.catalog.capabilityNames.filter(name => !config.sharedCapabilities.includes(name)));
    await writeFile(path, JSON.stringify({ ...config, sharedCapabilities: ['missing_capability'] }));
    await assert.rejects(loadStudioPetRoleContext('issuer', root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the real Channel provider supplies the role fixture hint without putting it in system sections', async () => {
  const request = channelDispatchInput({ channelId: studioPetEvalChannelId, messageId: randomUUID(), sequence: 1,
    author: { kind: 'human', id: 'owner' }, body: randomUUID(), occurredAt: '2026-01-01T00:00:00.000Z',
    mentions: [],
  });
  const context = await loadStudioPetRoleContext('reviewer', undefined, undefined, request);
  const hint = context.runtimeContext.hint;
  assert.ok(hint);
  assert.equal(hint.source, 'channel');
  assert.equal(hint.focus, undefined);
  assert.ok(hint.instruction.trim());
  assert.ok(Object.isFrozen(hint));
  assert.ok(context.systemPromptSections.every(section => !section.content.includes(hint.instruction)));
  assert.equal(context.messages[0]?.text, request);
  const fresh = await loadStudioPetRoleContext('reviewer');
  assert.equal(fresh.runtimeContext.hint?.focus, undefined);
  assert.equal(fresh.runtimeContext.hint?.instruction, hint.instruction);
});

test('real Entry goal and full Supervisor briefing reach the judge without executing a Capability', async () => {
  const testCase = example('issuer', 'entry');
  const goal = randomUUID();
  const briefing = randomUUID();
  const model = new ScriptedModel([
    call('plan_request', { goal }),
    call('capability_details', { names: ['studio_issue'] }),
    call('submit_plan', { tasks: [{ capability: 'studio_issue', objective: goal }] }),
    call('delegate_capability', { briefing }),
  ]);
  const { judge, received } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase, model, judge });
  assert.equal(model.inputs.length, 4);
  assert.equal(result.output.goal, goal);
  assert.deepEqual(result.output.delegations, [{ args: { briefing }, capability: 'studio_issue' }]);
  assert.equal(received.length, 1);
  const { modelCalls: _diagnostics, scope: _harnessScope, executions, ...candidateOutput } = result.output;
  assert.deepEqual(received[0]!.candidateOutput, candidateOutput);
  assert.deepEqual(received[0]!.evidence.returnedExecutions, executions);
  assert.equal(received[0]!.evidence.evaluationBoundary.phase, testCase.phase);
  assert.equal(received[0]!.evidence.evaluationBoundary.execution, 'stopped-before-first-capability-execution');
  assert.deepEqual(received[0]!.acceptanceCriteria, testCase.expected.criteria);
  assert.ok(result.scores.every(item => item.score === 1));
  assert.ok(result.scores.some(item => item.evaluator === 'llm-judge'));
  // Dynamic source boundaries, not a test of fixed prompt wording.
  const context = await loadStudioPetRoleContext('issuer');
  assert.ok(context.runtimeContext.hint);
  assert.deepEqual(context.systemPromptSections.map(section => section.id), [
    'pet:document', 'host:runtime-environment', 'channel:protocol', 'channel:metadata', 'channel:context',
  ]);
  for (const messages of model.inputs) {
    assert.equal(messages.filter(message => message.text.includes(context.runtimeContext.hint!.instruction)).length, 1);
    const systems = messages.filter(message => message._getType() === 'system');
    assert.equal(systems.length, 1);
    const system = systems[0]!.text;
    let previous = -1;
    for (const section of context.systemPromptSections) {
      assert.equal(system.split(section.content).length - 1, 1);
      const position = system.indexOf(section.content);
      assert.ok(position > previous);
      previous = position;
      assert.ok(messages.filter(message => message._getType() !== 'system')
        .every(message => !message.text.includes(section.content)), 'common context is not copied into ordinary messages');
    }
    const workdir = JSON.stringify(context.runtimeContext.workdir);
    assert.equal(system.split(workdir).length - 1, 1);
    assert.ok(system.indexOf(workdir) > previous);
  }
  for (const entry of context.catalog.entries) {
    assert.ok(model.inputs[0]!.some(message => message.text.includes(entry.description)));
  }
  const details = model.inputs[2]!.find(message => ToolMessage.isInstance(message) && message.name === 'capability_details');
  assert.ok(details);
  assert.deepEqual(JSON.parse(details.text).documents.map((document: { content: string }) => document.content),
    [context.catalog.entries.find(entry => entry.capabilityName === 'studio_issue')!.content]);
  assert.deepEqual(result.output.disclosedCapabilities, ['studio_issue']);
  const capabilityBody = context.catalog.entries.find(entry => entry.capabilityName === 'studio_issue')!.content;
  assert.ok(model.inputs[0]!.every(message => !message.text.includes(capabilityBody)), 'Entry sees summaries, not full Capability instructions');
  assert.ok(model.inputs[1]!.every(message => !message.text.includes(capabilityBody)), 'a fresh Supervisor has no previously disclosed bodies');
  assert.ok(model.inputs.every(messages => !messages[0]!.text.includes(capabilityBody)), 'Supervisor Capability disclosure is not an extra system section');
  assert.ok((result.output.entry as Array<{ type: string }>).every(message => message.type !== 'human'));
  assert.equal(model.inputs.flat().some(message => message.text.includes(testCase.expected.criteria[0]!.statement)), false);
});

test('Boundary uses a valid native delivery and can finish its own review despite a defect', async () => {
  const original = example('reviewer', 'boundary');
  const delivery = randomUUID();
  const testCase = { ...original, boundary: { ...original.boundary!, delivery,
    disclosedCapabilities: [original.boundary!.capability] } };
  const context = await loadStudioPetRoleContext('reviewer');
  const input = buildStudioPetBoundaryInput(testCase, context.catalog);
  const previousCall = (input.messages.find(message => AIMessage.isInstance(message)) as AIMessage).tool_calls![0]!;
  assert.doesNotThrow(() => parseSupervisorControl(previousCall));
  const records = readCapabilityExecutions(input.messages);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.result.delivery?.text, delivery);
  assert.equal(records[0]!.execution.planItemId, input.state.plan[0]!.id);
  assert.equal(records[0]!.result.delivery?.scope.runId, input.runId);
  assert.equal(records[0]!.result.delivery?.scope.taskId, input.taskId);
  assert.equal(records[0]!.result.delivery?.scope.delegationId, records[0]!.execution.delegationId);
  assert.deepEqual(buildStudioPetBoundaryInput(testCase, context.catalog).state, input.state);
  const renamedCase = buildStudioPetBoundaryInput({ ...testCase, id: randomUUID() }, context.catalog);
  assert.notEqual(renamedCase.runId, input.runId);
  assert.equal(input.messages.some(message => message.text.includes(testCase.id)), false, 'case labels do not enter runtime IDs');
  const model = new ScriptedModel([
    call('review_current', { completed: true, reason: 'The review delivery is complete.' }),
    new AIMessage('The review found a defect; the implementation owner can address the finding.'),
  ]);
  const { judge, received } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase, model, judge });
  assert.equal(model.inputs.length, 2);
  assert.ok(context.runtimeContext.hint);
  for (const messages of model.inputs) {
    assert.equal(messages.filter(message => message.text.includes(context.runtimeContext.hint!.instruction)).length, 1);
    assert.equal(messages[0]!.text.includes(context.runtimeContext.hint.instruction), false);
  }
  assert.ok(model.inputs[0]!.some(message => message.text.includes(delivery)));
  const capabilityBody = context.catalog.entries.find(entry => entry.capabilityName === testCase.boundary.capability)!.content;
  assert.ok(model.inputs.every(messages => messages.some(message =>
    message._getType() === 'human' && message.text.includes(capabilityBody))), 'Boundary restores the disclosed Capability in its temporary context');
  assert.ok(model.inputs.every(messages => !messages[0]!.text.includes(capabilityBody)));
  assert.equal(received[0]!.evidence.boundary.delivery, delivery);
  assert.equal(received[0]!.evidence.evaluationBoundary.phase, testCase.phase);
  assert.equal(received[0]!.evidence.evaluationBoundary.execution, 'prior-delivery-supplied-next-delegation-not-executed');
  assert.deepEqual(result.output.delegations, []);
  assert.equal(result.output.kind, 'reply');
  assert.ok(result.scores.every(item => item.score === 1));
});

test('a valid own-Capability delegation does not erase a semantic briefing failure', async () => {
  const testCase = example('issuer', 'boundary');
  const failedId = testCase.expected.criteria[1]!.id;
  const briefing = 'Implement the missing change and add regression tests before reporting status.';
  const model = new ScriptedModel([
    call('review_current', { completed: true, reason: 'Context collected.' }),
    call('delegate_capability', { briefing }),
  ]);
  const { judge, received } = recordingJudge(failedId);
  const result = await runStudioPetRoleCase({ testCase, model, judge });
  assert.ok(result.scores.filter(item => item.evaluator === 'deterministic').every(item => item.score === 1));
  assert.equal(result.scores.find(item => item.key === failedId)!.score, 0);
  assert.deepEqual(received[0]!.candidateOutput.delegations, [{ args: { briefing }, capability: 'studio_issue' }]);
  assert.ok((received[0]!.candidateOutput.supervisor as Array<{ calls?: unknown[] }>).some(message => message.calls?.length));
});

function wikiAwaitingHumanCase(): StudioPetRoleCase {
  const original = example('wiki', 'boundary');
  return { ...original, request: '来源冲突时请说明需要人类决定的内容，不擅自确定产品行为。',
    boundary: { ...original.boundary!, delivery: '两个来源对产品行为的要求互相冲突，当前没有权威决定。页面尚未写入，需要人类选择保留哪项行为。' },
    expected: { ...original.expected, criteria: [{ id: 'pending_decision_truthful',
      statement: '说明来源冲突并请求人类决定，保留待完成工作，不声称页面已经更新。' }] },
  };
}

test('a legitimate human question can preserve pending work without a structural failure', async () => {
  const testCase = wikiAwaitingHumanCase();
  const { judge, received } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase,
    model: new ScriptedModel([new AIMessage('两个来源要求冲突，页面尚未更新。请确认采用哪项行为。')]), judge });
  assert.equal(result.output.kind, 'reply');
  assert.equal((result.output.plan as { plan: Array<{ status: string }> }).plan[0]!.status, 'pending');
  assert.ok(result.scores.filter(item => item.evaluator === 'deterministic').every(item => item.score === 1));
  assert.equal(result.scores.some(item => item.key === 'completed_own_work'), false);
  assert.equal(received[0]!.evidence.boundary.delivery, testCase.boundary!.delivery);
});

test('a false completion claim is evaluated semantically against the supplied incomplete delivery', async () => {
  const testCase = wikiAwaitingHumanCase();
  const failedId = testCase.expected.criteria[0]!.id;
  const { judge, received } = recordingJudge(failedId);
  const result = await runStudioPetRoleCase({ testCase, model: new ScriptedModel([new AIMessage('Done.')]), judge });
  assert.ok(result.scores.filter(item => item.evaluator === 'deterministic').every(item => item.score === 1));
  assert.equal(result.scores.find(item => item.key === failedId)!.score, 0);
  assert.equal(received[0]!.evidence.boundary.delivery, testCase.boundary!.delivery);
  assert.equal(received[0]!.candidateOutput.reply, 'Done.');
});

test('a rejected delegation followed by a reply is not counted as a successful handoff', async () => {
  const testCase = example('executor', 'entry');
  const model = new ScriptedModel([
    call('plan_request', { goal: 'Repair the authorized pagination defect.' }),
    call('delegate_capability', { briefing: 'Implement before a task has been planned.' }),
    call('submit_plan', { tasks: [{ capability: 'studio_execution', objective: 'Repair the authorized pagination defect.' }] }),
    new AIMessage('Will implement.'),
  ]);
  const { judge } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase, model, judge });
  assert.equal(result.output.kind, 'reply');
  assert.deepEqual(result.output.delegations, []);
  assert.equal(result.scores.find(item => item.key === 'expected_decision')!.score, 0);
  assert.equal(model.inputs.length, 4);
});

test('Issuer can reply directly and the selected Channel announcement reaches the subject', async () => {
  const testCase = example('issuer', 'entry');
  const announcement = randomUUID();
  const model = new ScriptedModel([new AIMessage('Existing evidence supports a bounded status update.')]);
  const { judge } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase, model, judge, channelAnnouncement: announcement });
  assert.equal(model.inputs.length, 1);
  assert.equal(result.output.goal, null);
  assert.equal(result.output.kind, 'reply');
  assert.ok(result.scores.every(item => item.score === 1));
  assert.ok(model.inputs[0]!.some(message => message._getType() === 'system' && message.text.includes(announcement)));
});

test('isolated provider fixtures retain stable inputs and do not leak another role announcement', async () => {
  const alpha = randomUUID(), beta = randomUUID();
  const [first, second, repeated] = await Promise.all([
    loadStudioPetRoleContext('issuer', undefined, alpha),
    loadStudioPetRoleContext('reviewer', undefined, beta),
    loadStudioPetRoleContext('issuer', undefined, alpha),
  ]);
  assert.deepEqual(first.runtimeContext, repeated.runtimeContext);
  for (const [context, own, other] of [[first, alpha, beta], [second, beta, alpha]] as const) {
    const announcement = context.systemPromptSections.find(section => section.id === 'channel:context')!;
    assert.ok(announcement.content.includes(own));
    assert.ok(context.systemPromptSections.every(section => !section.content.includes(other)));
  }
});

test('Boundary execution alone does not imply that Supervisor previously read the Capability body', async () => {
  const testCase = example('reviewer', 'boundary');
  const context = await loadStudioPetRoleContext('reviewer');
  const input = buildStudioPetBoundaryInput(testCase, context.catalog);
  assert.deepEqual(input.capabilityDisclosure.disclosedCapabilityNames, []);
  const body = context.catalog.entries.find(entry => entry.capabilityName === testCase.boundary!.capability)!.content;
  const model = new ScriptedModel([
    call('review_current', { completed: true, reason: 'The finding is the completed review delivery.' }), new AIMessage('Finding ready for the implementation owner.'),
  ]);
  await runStudioPetRoleCase({ testCase, model, judge: recordingJudge().judge });
  assert.ok(model.inputs.flat().every(message => !message.text.includes(body)));
});

test('a continuous run preserves the model goal, actual briefing, disclosure and shared identity through Boundary', async () => {
  const testCase = example('reviewer', 'flow');
  const goal = randomUUID(), briefing = randomUUID(), announcement = randomUUID();
  const context = await loadStudioPetRoleContext('reviewer', undefined, announcement);
  const model = new ScriptedModel([
    call('plan_request', { goal }),
    call('submit_plan', { tasks: [{ capability: 'studio_review', objective: goal }] }),
    call('delegate_capability', { briefing }),
    call('review_current', { completed: true, reason: 'Review delivery is complete; the defect belongs to implementation.' }),
    new AIMessage('Review completed with a concrete finding for Executor.'),
  ]);
  const { judge, received } = recordingJudge();
  const result = await runStudioPetRoleCase({ testCase, model, judge, channelAnnouncement: announcement,
    captureSyntheticContent: true });
  assert.equal(result.output.goal, goal);
  assert.deepEqual(result.output.delegations, [{ args: { briefing }, capability: 'studio_review' }]);
  assert.deepEqual(result.output.disclosedCapabilities, []);
  assert.equal((result.output.executions as any[])[0].result.delivery.text, testCase.flow!.deliveries.studio_review);
  assert.equal((result.output.plan as any).plan[0].status, 'completed');
  const records = result.output.modelCalls as StudioPetModelObservation[];
  assert.deepEqual(records.map(record => record.stage), ['entry', 'supervisor-entry', 'supervisor-entry', 'capability', 'supervisor-boundary', 'supervisor-boundary']);
  for (const record of records) {
    const messages = record.prompts[0]!.messages;
    assert.ok(messages[0]!.text!.includes(announcement));
    for (const section of context.systemPromptSections) assert.equal(messages[0]!.text!.split(section.content).length - 1, 1);
  }
  const child = records.find(record => record.stage === 'capability')!;
  assert.ok(child.prompts[0]!.sources.find(source => source.id === 'capability-body:studio_review')!.locations.some(location => location.role === 'system'));
  for (const record of records.filter(record => record.stage.startsWith('supervisor'))) {
    assert.deepEqual(record.prompts[0]!.sources.find(source => source.id === 'capability-document:studio_review')!.locations, []);
  }
  assert.equal(Object.hasOwn(received[0]!.candidateOutput, 'modelCalls'), false, 'raw prompt diagnostics are not duplicated into the judge input');
  assert.equal(Object.hasOwn(received[0]!.candidateOutput, 'scope'), false, 'harness execution limitations are not confused with the subject’s claims');
  assert.equal(Object.hasOwn(received[0]!.candidateOutput, 'executions'), false);
  assert.equal(received[0]!.evidence.returnedExecutions[0].result.delivery.text, testCase.flow!.deliveries.studio_review);
  assert.equal(received[0]!.evidence.scenario.kind, 'controlled-simulation');
  assert.equal(received[0]!.evidence.evaluationBoundary.phase, testCase.phase);
  assert.equal(received[0]!.evidence.evaluationBoundary.execution, 'controlled-capability-deliveries-returned-during-run');
  assert.ok(result.scores.every(score => score.score === 1));
});

test('a failed model call preserves observed inputs for diagnosis without manufacturing a decision', async () => {
  await assert.rejects(runStudioPetRoleCase({ testCase: example('issuer', 'entry'),
    model: new ScriptedModel([]), judge: recordingJudge().judge }), error => {
    assert.ok(error instanceof StudioPetRoleInvocationError);
    const records = error.partial.output.modelCalls as StudioPetModelObservation[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, 'error');
    assert.ok(records[0]!.prompts[0]!.messages.every(message => message.text === undefined));
    assert.deepEqual(error.partial.scores, []);
    return true;
  });
});

test('a direct reply in a flow does not present the captured raw Channel input as a model-set goal', async () => {
  const result = await runStudioPetRoleCase({ testCase: example('issuer', 'flow'),
    model: new ScriptedModel([new AIMessage('The supplied status already identifies the missing work and responsible roles.')]),
    judge: recordingJudge().judge });
  assert.equal(result.output.goal, null);
  assert.equal(result.output.kind, 'reply');
  assert.deepEqual(result.output.executions, []);
});

test('unavailable semantic judge fails the run rather than silently passing deterministic scores', async () => {
  const testCase = example('executor', 'boundary');
  const { judge } = recordingJudge();
  judge.model = { withStructuredOutput: () => ({ invoke: async () => { throw new Error('Offline judge'); } }) } as never;
  const model = new ScriptedModel([
    call('review_current', { completed: true, reason: 'Delivered.' }), new AIMessage('Delivered.'),
  ]);
  await assert.rejects(runStudioPetRoleCase({ testCase, model, judge }), { name: 'PromptEvalJudgeError' });
});
