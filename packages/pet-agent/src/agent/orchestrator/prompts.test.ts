import { DelegationAnnounceMessage } from './delegation';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunSupervisorAgentInput,
  buildRunSupervisorAgentSystemPrompt,
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

function supervisorSession(
  capabilityDisclosure = plannerDisclosure,
  plan: RunSupervisorInput['remainingPlan'] = [],
) {
  return {
    runId: 'run-1',
    plan,
    capabilityDisclosure,
  };
}

test('Run Supervisor entry input leads with the run user request', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: null,

    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /打开示例站点并浏览相关内容。/);
  assert.match(input, /浏览器已经连接。/);
  assert.match(input, /<capability_context source="supervisor_state" trust="read_only">/);
  assert.match(input, /<capability_routing_manifest[^>]* default="general">/);
  assert.match(input, /<purpose>\s*<!\[CDATA\[\s*打开并检查网页/);
  assert.match(input, /<toolkit name="browser">/);
  assert.match(input, /打开网页并读取浏览器页面内容。/);
  assert.match(input, /<capability name="general">/);
  assert.match(input, /<capability name="browser">/);
  assert.match(input, /保留 \]\]\]\]>\<!\[CDATA\[> 作为文档数据。/);
  assert.doesNotMatch(input, /registry_digest|document_count|<planning_state>/);
});

test('Run Supervisor system prompt contains no dynamic Capability state', () => {
  const systemPrompt = buildRunSupervisorAgentSystemPrompt('entry');
  assert.doesNotMatch(systemPrompt, /<capability_context|<default_capability|registry_digest/);
  assert.doesNotMatch(systemPrompt, /# General|# Browser/);
});

test('Run Supervisor entry input represents an empty disclosure explicitly', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '整理下载目录。',
    messages: [],
    activeDelegation: null,

    remainingPlan: [],
    capabilityDisclosure: {
      ...plannerDisclosure,
      disclosedCapabilityNames: [],
    },
    supervisorSession: supervisorSession({
      ...plannerDisclosure,
      disclosedCapabilityNames: [],
    }),
  } satisfies RunSupervisorInput, [], routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<capability_context[^>]*>\n  <none \/>\n<\/capability_context>/);
});

test('Run Supervisor boundary input carries the run user request and boundary facts', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [...[], ...[{
      messageId: 'announce-1',
      result: '浏览器已连接。',
    }].map((attempt) => new DelegationAnnounceMessage({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:browser' as const, delegationId: 'delegation-1', runId: 'run-1', task: '确认浏览器可用', announceMessageId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },

    remainingPlan: [{
      capability: 'browser',
      task: '浏览相关内容',
    }],
    capabilityDisclosure: plannerDisclosure,
    supervisorSession: supervisorSession(plannerDisclosure, [{
      capability: 'browser',
      task: '浏览相关内容',
    }]),
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<supervision_boundary_event role="task_boundary" source="orchestrator_state">/);
  assert.match(input, /<active_delegation delegation_id="delegation-1" capability="browser" run_id="run-1">/);

  assert.match(input, /确认浏览器可用/);
  assert.match(input, /<prior_remaining_plan role="plan" source="supervisor_session" status="stable_until_user_confirmation">/);
  assert.match(input, /<task capability="browser">/);
  assert.match(input, /浏览相关内容/);
  assert.doesNotMatch(input, /执行停止原因/);
  assert.doesNotMatch(input, /registry_digest|document_count|<planning_state>/);
});

test('Run Supervisor boundary input omits the follow-up section once the plan is exhausted', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    catalog: plannerPromptCatalog,
    userRequest: '打开示例站点并浏览相关内容。',
    messages: [...[], ...[{
      messageId: 'announce-1',
      result: '浏览器已连接。',
    }].map((attempt) => new DelegationAnnounceMessage({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:browser' as const, delegationId: 'delegation-1', runId: 'run-1', task: '确认浏览器可用', announceMessageId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },

    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<active_delegation delegation_id="delegation-1" capability="browser" run_id="run-1">/);
  assert.match(input, /<prior_remaining_plan role="plan" source="supervisor_session" status="stable_until_user_confirmation" \/>/);
  assert.doesNotMatch(input, /此前保留的后续任务|planner_request_briefing/);
});
