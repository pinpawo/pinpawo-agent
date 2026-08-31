import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunSupervisorAgentInput,
  buildRunSupervisorAgentSystemPrompt,
} from './prompts/runSupervisorAgent';
import type { RunSupervisorInput } from './runSupervisor/runner';

const plannerPromptWorkspace = {
  rootPath: '/tmp/capabilities',
  registryDigest: 'a'.repeat(64),
  capabilityNames: ['general', 'browser'],
  entries: ['general', 'browser'].map((capabilityName) => ({
    capabilityName,
    description: `${capabilityName} capability`,
    toolkits: [],
    relativePath: `${capabilityName}/CAPABILITY.md`,
    documentDigest: 'b'.repeat(64),
    provenance: 'authored' as const,
  })),
  reused: false,
};

const plannerDisclosure = {
  registryDigest: plannerPromptWorkspace.registryDigest,
  disclosedCapabilityNames: ['general', 'browser'],
  emptySearchRounds: 0,
  maxEmptySearchRounds: 2,
  status: 'open' as const,
};

const disclosedDocuments = [{
  capabilityName: 'general',
  path: 'general/CAPABILITY.md',
  content: '# General\n\n使用本地工具；保留 ]]> 作为文档数据。',
}, {
  capabilityName: 'browser',
  path: 'browser/CAPABILITY.md',
  content: '# Browser\n\n浏览网页。',
}];

const routingManifest = {
  defaultCapabilityName: 'general',
  capabilities: [{
    name: 'general',
    purpose: '处理通用工作区任务',
    cues: ['general', 'workspace', 'task'],
    toolkits: [{
      name: 'workspace',
      description: '读取、编辑并验证本地工作区文件。',
    }],
  }, {
    name: 'browser',
    purpose: '打开并检查网页',
    cues: ['browser', 'web page', 'navigate'],
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
    revision: 0,
    plan,
    capabilityDisclosure,
    lastCommand: null,
  };
}

test('Run Supervisor entry input leads with the run user request', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    announceAttempts: [],
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
  assert.match(input, /<cue>\s*<!\[CDATA\[\s*browser/);
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
    workspace: plannerPromptWorkspace,
    userRequest: '整理下载目录。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    announceAttempts: [],
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
    workspace: plannerPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },
    latestAnnounce: {
      messageId: 'announce-1',
      completionReason: 'natural',
      result: '浏览器已连接。',
    },
    announceAttempts: [{
      messageId: 'announce-1',
      completionReason: 'natural',
      result: '浏览器已连接。',
    }],
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
  assert.match(input, /<active_delegation delegation_id="delegation-1" capability="browser">/);
  assert.match(input, /<delegation_announces delegation_id="delegation-1" evidence_state="available" evaluation_target="announce-1">/);
  assert.match(input, /浏览器已连接。/);
  assert.match(input, /确认浏览器可用/);
  assert.match(input, /<prior_remaining_plan role="proposal" source="supervisor_session" authority="none" status="requires_revalidation">/);
  assert.match(input, /<task capability="browser">/);
  assert.match(input, /浏览相关内容/);
  assert.doesNotMatch(input, /执行停止原因/);
  assert.doesNotMatch(input, /registry_digest|document_count|<planning_state>/);
});

test('Run Supervisor boundary input marks absent execution evidence explicitly', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'human:run-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userRequest: '继续检查仓库并完成测试验证。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'general',
      task: '检查仓库并完成测试验证',
    },
    latestAnnounce: null,
    announceAttempts: [],
    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(
    input,
    /<delegation_announces delegation_id="delegation-1" evidence_state="absent" \/>/,
  );
  assert.doesNotMatch(input, /evaluation_target=/);
  assert.doesNotMatch(input, /<delegation_announce /);
});

test('Run Supervisor boundary input omits the follow-up section once the plan is exhausted', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },
    latestAnnounce: {
      messageId: 'announce-1',
      completionReason: 'natural',
      result: '浏览器已连接。',
    },
    announceAttempts: [{
      messageId: 'announce-1',
      completionReason: 'natural',
      result: '浏览器已连接。',
    }],
    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments, routingManifest);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<active_delegation delegation_id="delegation-1" capability="browser">/);
  assert.match(input, /<prior_remaining_plan role="proposal" source="supervisor_session" authority="none" status="requires_revalidation" \/>/);
  assert.doesNotMatch(input, /此前保留的后续任务|planner_request_briefing/);
});
