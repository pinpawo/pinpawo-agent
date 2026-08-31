import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubagentAnnounceContext } from './prompts';
import {
  buildRunSupervisorAgentInput,
  buildRunSupervisorAgentSystemPrompt,
} from './prompts/runSupervisorAgent';
import type { RunSupervisorInput } from './runSupervisor/runner';

const supervisorPromptWorkspace = {
  rootPath: '/tmp/capabilities',
  registryDigest: 'a'.repeat(64),
  capabilityNames: ['general', 'browser'],
  entries: ['general', 'browser'].map((capabilityName) => ({
    capabilityName,
    relativePath: `${capabilityName}/CAPABILITY.md`,
    documentDigest: 'b'.repeat(64),
    provenance: 'authored' as const,
  })),
  reused: false,
};

const supervisorDisclosure = {
  registryDigest: supervisorPromptWorkspace.registryDigest,
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

function supervisorSession(
  capabilityDisclosure = supervisorDisclosure,
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
    workspace: supervisorPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    announceAttempts: [],
    remainingPlan: [],
    capabilityDisclosure: supervisorDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /打开示例站点并浏览相关内容。/);
  assert.match(input, /浏览器已经连接。/);
  assert.match(input, /<capability_context source="supervisor_state" trust="read_only">/);
  assert.match(input, /<capability name="general">/);
  assert.match(input, /<capability name="browser">/);
  assert.match(input, /保留 \]\]\]\]>\<!\[CDATA\[> 作为文档数据。/);
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
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
    workspace: supervisorPromptWorkspace,
    userRequest: '整理下载目录。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    announceAttempts: [],
    remainingPlan: [],
    capabilityDisclosure: {
      ...supervisorDisclosure,
      disclosedCapabilityNames: [],
    },
    supervisorSession: supervisorSession({
      ...supervisorDisclosure,
      disclosedCapabilityNames: [],
    }),
  } satisfies RunSupervisorInput, []);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<capability_context[^>]*>\n  <none \/>\n<\/capability_context>/);
});

test('Run Supervisor boundary input carries the run user request and boundary facts', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: supervisorPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      transcriptRunId: 'transcript-1',
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
    capabilityDisclosure: supervisorDisclosure,
    supervisorSession: supervisorSession(supervisorDisclosure, [{
      capability: 'browser',
      task: '浏览相关内容',
    }]),
  } satisfies RunSupervisorInput, disclosedDocuments);

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
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
});

test('Run Supervisor boundary input marks absent execution evidence explicitly', () => {
  const input = buildRunSupervisorAgentInput({
    mode: 'boundary',
    inputId: 'human:run-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: supervisorPromptWorkspace,
    userRequest: '继续检查仓库并完成测试验证。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      transcriptRunId: 'transcript-1',
      capability: 'general',
      task: '检查仓库并完成测试验证',
    },
    latestAnnounce: null,
    announceAttempts: [],
    remainingPlan: [],
    capabilityDisclosure: supervisorDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments);

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
    workspace: supervisorPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。',
    messages: [],
    activeDelegation: {
      delegationId: 'delegation-1',
      transcriptRunId: 'transcript-1',
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
    capabilityDisclosure: supervisorDisclosure,
    supervisorSession: supervisorSession(),
  } satisfies RunSupervisorInput, disclosedDocuments);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<active_delegation delegation_id="delegation-1" capability="browser">/);
  assert.match(input, /<prior_remaining_plan role="proposal" source="supervisor_session" authority="none" status="requires_revalidation" \/>/);
  assert.doesNotMatch(input, /此前保留的后续任务|supervisor_request_briefing/);
});

test('completed subagent announce context includes the full current result text', () => {
  const longResult = [
    '# Vibe Coding 模型排行榜',
    'A'.repeat(1400),
    'END_OF_FULL_RANKING_MARKER',
  ].join('\n\n');
  const context = buildSubagentAnnounceContext({
    messageId: null,
    lane: 'capability:general',
    delegationId: 'task-1',
    task: '整理排行榜',
    text: longResult,
  }, 'natural');

  assert.match(context ?? '', /<result format="markdown" role="data">/);
  assert.match(context ?? '', /# Vibe Coding 模型排行榜/);
  assert.match(context ?? '', /END_OF_FULL_RANKING_MARKER/);
});

test('subagent announce wraps markdown result as an xml-ish data block', () => {
  const context = buildSubagentAnnounceContext({
    messageId: null,
    lane: 'capability:general',
    delegationId: 'task-1',
    task: '修复 lint',
    text: '# 结果\n\n- 已修复 lint\n- 已验证',
  }, 'natural') ?? '';

  assert.match(context, /<subagent_announce>/);
  assert.match(context, /<result format="markdown" role="data">/);
  assert.match(context, /<!\[CDATA\[/);
  assert.match(context, /# 结果/);
  assert.match(context, /<\/result>/);
  assert.doesNotMatch(context, /delegated task：/);
});

test('subagent announce context includes artifact refs for task ownership', () => {
  const context = buildSubagentAnnounceContext({
    messageId: null,
    lane: 'capability:explore',
    delegationId: 'task-1',
    task: '修复 lint',
    artifactRefs: [
      {
        id: 'artifact-1',
        kind: 'report',
        mimeType: 'text/markdown',
        uri: 'capability-artifact://thread/thread-1/artifact/report-1',
        title: 'Issue explore report',
        preview: '已确认关键文件和下一步。',
        capabilityId: 'explore',
        delegationId: 'task-1',
        runId: 'run-1',
      },
    ],
    text: '# 结果\n\n- 已完成',
  }, 'natural') ?? '';

  assert.match(context, /<artifacts>/);
  assert.match(context, /<artifact>/);
  assert.match(context, /Issue explore report/);
  assert.match(context, /capability-artifact:\/\/thread\/thread-1/);
});

test('subagent announce context clips artifact summaries', () => {
  const long = 'title-payload-'.repeat(80);
  const context = buildSubagentAnnounceContext({
    messageId: null,
    lane: 'capability:explore',
    delegationId: 'task-1',
    task: '整理 ranking',
    artifactRefs: [
      {
        id: 'artifact-1',
        kind: 'report',
        mimeType: 'text/markdown',
        uri: 'capability-artifact://thread/thread-1/artifact/' + `${'x'.repeat(400)}`,
        title: long,
        preview: long,
        capabilityId: 'explore',
        delegationId: 'task-1',
        runId: 'run-1',
      },
    ],
    text: '# 结果',
  }) ?? '';

  assert.match(context, /<artifacts>/);
  assert.equal(context.includes(long), false);
  assert.match(context, /…/);
});
