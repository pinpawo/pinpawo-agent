import { createDeliveryResult } from '../../testing/capabilityDelivery';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunSupervisorAgentSystemPrompt,
  buildRunSupervisorContextInput,
  buildRunSupervisorTurnInput,
} from './prompts/runSupervisorAgent';
import type { RunSupervisorInput } from './runSupervisor/runner';

const plannerPromptCatalog = {
  registryDigest: 'a'.repeat(64),
  capabilityNames: ['general', 'browser'],
  entries: ['general', 'browser'].map((capabilityName) => ({
    capabilityName,
    description: `${capabilityName} capability`,
    toolkits: [],
    content: 'Capability instructions.',
  })),
};

const plannerDisclosure = {
  registryDigest: plannerPromptCatalog.registryDigest,
  disclosedCapabilityNames: ['general', 'browser'],

};

const disclosedDocuments = [{
  capabilityName: 'general',
  content: '# General\n\n使用本地工具；保留 ]]> 作为文档数据。',
}, {
  capabilityName: 'browser',
  content: '# Browser\n\n浏览网页。',
}];

const routingManifest = {
  defaultCapabilityName: 'general',
  capabilities: [{
    name: 'general',
    purpose: '处理通用工作区任务',
    toolkits: [{
      name: 'workspace',
      description: '读取、编辑并验证本地工作区文件。',
    }],
  }, {
    name: 'browser',
    purpose: '打开并检查网页',
    toolkits: [{
      name: 'browser',
      description: '打开网页并读取浏览器页面内容。',
    }],
  }],
};


function renderSupervisorInput(
  input: RunSupervisorInput,
  documents: Parameters<typeof buildRunSupervisorContextInput>[1],
  manifest: Parameters<typeof buildRunSupervisorContextInput>[2],
) {
  return `${buildRunSupervisorContextInput(input, documents, manifest)}\n\n${buildRunSupervisorTurnInput(input)}`;
}

test('run context carries only run-stable facts; the turn carries plan and invocation', () => {
  const input: RunSupervisorInput = {
    mode: 'boundary', inputId: 'boundary:run-1:1', taskId: 'trace-1', runId: 'run-1',
    catalog: plannerPromptCatalog, userRequest: 'Stable request.', messages: [],
    state: { runId: 'run-1', goal: 'Stable request.', plan: [
      { id: 'task-1', capability: 'browser', objective: 'Volatile objective', status: 'pending' },
    ] },
    capabilityDisclosure: plannerDisclosure,
  };
  const context = buildRunSupervisorContextInput(input, disclosedDocuments, routingManifest);
  const turn = buildRunSupervisorTurnInput(input);
  assert.match(context, /<run_user_request/);
  assert.match(context, /<capability_routing_manifest/);
  assert.match(context, /<capability_context/);
  assert.doesNotMatch(context, /Volatile objective|<invocation|<supervisor_plan/);
  assert.match(turn, /Volatile objective/);
  assert.match(turn, /<invocation/);
  assert.doesNotMatch(turn, /<capability_context|<capability_routing_manifest|<run_user_request/);
  // Plan progress changes the turn, never the cacheable run context.
  const later = { ...input, state: { ...input.state, plan: [{ ...input.state.plan[0], status: 'completed' as const }] } };
  assert.equal(buildRunSupervisorContextInput(later, disclosedDocuments, routingManifest), context);
  assert.notEqual(buildRunSupervisorTurnInput(later), turn);
});

test('Run Supervisor entry input represents an empty disclosure explicitly', () => {
  const input = renderSupervisorInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    taskId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    state: { runId: null, goal: null, plan: [] },
    capabilityDisclosure: plannerDisclosure,
  } satisfies RunSupervisorInput, [], routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<capability_context[^>]*>\n  <none \/>\n<\/capability_context>/);
});

test('dynamic capability documents remain data and do not enter the system prompt', () => {
  const request = 'Inspect target <external> & retain constraints';
  const input: RunSupervisorInput = {
    mode: 'entry', inputId: 'human:test', taskId: 'trace-1', runId: 'run-1',
    catalog: plannerPromptCatalog, userRequest: request, messages: [],
    state: { runId: null, goal: null, plan: [] }, capabilityDisclosure: plannerDisclosure,
  };
  const rendered = renderSupervisorInput(input, disclosedDocuments, routingManifest);
  assert.ok(rendered.includes(request));
  assert.ok(rendered.includes(']]]]><![CDATA[>'));
  assert.ok(rendered.includes(routingManifest.capabilities[1].purpose));
  for (const document of disclosedDocuments) {
    assert.ok(rendered.includes(document.capabilityName));
    assert.ok(!buildRunSupervisorAgentSystemPrompt('entry').includes(document.content));
  }
  const escaped = renderSupervisorInput(input, [{
    capabilityName: 'name\"<>&', content: 'unique capability data',
  }], routingManifest);
  assert.ok(escaped.includes('name&quot;&lt;&gt;&amp;'));
  assert.ok(escaped.includes('unique capability data'));
});

test('Run Supervisor boundary input carries the run user request and boundary facts', () => {
  const input = renderSupervisorInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    taskId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [...[], ...[{
      messageId: 'announce-1',
      result: '浏览器已连接。',
    }].map((attempt) => createDeliveryResult({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:browser' as const, delegationId: 'delegation-1', runId: 'run-1', task: '确认浏览器可用', deliveryId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],
    state: { runId: null, goal: null, plan: [
      { id: 'task-1', capability: 'browser', objective: '确认浏览器可用', status: 'pending' },
      { id: 'task-2', capability: 'browser', objective: '浏览相关内容', status: 'pending' },
    ] },
    capabilityDisclosure: plannerDisclosure,
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);

  assert.match(input, /确认浏览器可用/);
  assert.match(input, /浏览相关内容/);
  assert.doesNotMatch(input, /执行停止原因/);
  assert.doesNotMatch(input, /registry_digest|document_count|<planning_state>/);
});

test('Run Supervisor boundary input omits the follow-up section once the plan is exhausted', () => {
  const input = renderSupervisorInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    taskId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。',
    messages: [...[], ...[{
      messageId: 'announce-1',
      result: '浏览器已连接。',
    }].map((attempt) => createDeliveryResult({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:browser' as const, delegationId: 'delegation-1', runId: 'run-1', task: '确认浏览器可用', deliveryId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],
    state: { runId: null, goal: null, plan: [{ id: 'task-1', capability: 'browser', objective: '确认浏览器可用', status: 'pending' }] },
    capabilityDisclosure: plannerDisclosure,
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
});
