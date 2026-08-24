import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubagentAnnounceContext } from './prompts';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from './prompts/capabilityPlannerAgent';
import type { CapabilityPlannerInput } from './capabilityPlanner/runner';

const plannerPromptWorkspace = {
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

test('Capability Planner entry input leads with the run user request', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userRequest: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
  } satisfies CapabilityPlannerInput, disclosedDocuments);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /打开示例站点并浏览相关内容。/);
  assert.match(input, /浏览器已经连接。/);
  assert.match(input, /<capability_context source="planner_state" trust="read_only">/);
  assert.match(input, /<capability name="general">/);
  assert.match(input, /<capability name="browser">/);
  assert.match(input, /保留 \]\]\]\]>\<!\[CDATA\[> 作为文档数据。/);
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
});

test('Capability Planner system prompt contains no dynamic Capability state', () => {
  const systemPrompt = buildCapabilityPlannerAgentSystemPrompt('entry');
  assert.doesNotMatch(systemPrompt, /<capability_context|<default_capability|registry_digest/);
  assert.doesNotMatch(systemPrompt, /# General|# Browser/);
});

test('Capability Planner entry input represents an empty disclosure explicitly', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userRequest: '整理下载目录。',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
    capabilityDisclosure: {
      ...plannerDisclosure,
      disclosedCapabilityNames: [],
    },
  } satisfies CapabilityPlannerInput, []);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<capability_context[^>]*>\n  <none \/>\n<\/capability_context>/);
});

test('Capability Planner boundary input carries the run user request and boundary facts', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
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
    },
    remainingPlan: [{
      capability: 'browser',
      task: '浏览相关内容',
    }],
    capabilityDisclosure: plannerDisclosure,
  } satisfies CapabilityPlannerInput, disclosedDocuments);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<planning_boundary source="orchestrator_state" trust="read_only">/);
  assert.match(input, /<active_delegation capability="browser">/);
  assert.match(input, /确认浏览器可用/);
  assert.match(input, /<remaining_plan>/);
  assert.match(input, /<task capability="browser">/);
  assert.match(input, /浏览相关内容/);
  assert.doesNotMatch(input, /执行停止原因/);
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
});

test('Capability Planner boundary input omits the follow-up section once the plan is exhausted', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
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
    },
    remainingPlan: [],
    capabilityDisclosure: plannerDisclosure,
  } satisfies CapabilityPlannerInput, disclosedDocuments);

  assert.match(input, /^<run_user_request[^>]*>/);
  assert.match(input, /<active_delegation capability="browser">/);
  assert.match(input, /<remaining_plan \/>/);
  assert.doesNotMatch(input, /此前保留的后续任务|planner_request_briefing/);
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
