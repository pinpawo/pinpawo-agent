import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubagentAnnounceContext } from './prompts';
import { buildCapabilityPlannerAgentInput } from './prompts/capabilityPlannerAgent';
import type { CapabilityPlannerInput } from './capabilityPlanner/runner';

const plannerPromptWorkspace = {
  rootPath: '/tmp/capabilities',
  registryDigest: 'a'.repeat(64),
  capabilityNames: ['browser'],
  entries: [{
    capabilityName: 'browser',
    relativePath: 'browser/CAPABILITY.md',
    documentDigest: 'b'.repeat(64),
    provenance: 'authored' as const,
  }],
  reused: false,
};

test('Capability Planner entry input leads with the run user goal', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userGoal: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    latestUserMessage: null,
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
  } satisfies CapabilityPlannerInput);

  assert.match(input, /^<run_user_goal[^>]*>/);
  assert.match(input, /打开示例站点并浏览相关内容。/);
  assert.match(input, /浏览器已经连接。/);
  assert.equal(input.trimEnd().endsWith('</run_user_goal>'), true);
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
});

test('Capability Planner input keeps the verified default Capability private context after the goal', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'entry',
    inputId: 'trace_started:trace-1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userGoal: '整理下载目录。',
    latestUserMessage: null,
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
  } satisfies CapabilityPlannerInput, {
    capabilityName: 'general',
    path: 'general/CAPABILITY.md',
    content: '# General\n\n使用本地工具；保留 ]]> 作为文档数据。',
  });

  assert.match(input, /^<run_user_goal[^>]*>/);
  assert.match(input, /<default_capability[^>]*source="immutable_workspace"/);
  assert.match(input, /general\/CAPABILITY\.md/);
  assert.match(input, /使用本地工具；保留 \]\]\]\]>\<!\[CDATA\[> 作为文档数据。/);
  assert.ok(input.indexOf('</run_user_goal>') < input.indexOf('<default_capability'));
});

test('Capability Planner boundary input carries the run user goal and boundary facts', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userGoal: '打开示例站点并浏览相关内容。\n\n浏览器已经连接。',
    latestUserMessage: null,
    activeDelegation: {
      delegationId: 'delegation-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },
    latestAnnounce: {
      messageId: 'announce-1',
      text: '浏览器已经连接，目标页面可访问。',
      completionReason: 'natural',
    },
    remainingPlan: [{
      capability: 'browser',
      task: '浏览相关内容',
    }],
  } satisfies CapabilityPlannerInput);

  assert.match(input, /^<run_user_goal[^>]*>/);
  assert.match(input, /当前任务：确认浏览器可用/);
  assert.match(input, /浏览器已经连接，目标页面可访问。/);
  assert.match(input, /- \[browser\] 浏览相关内容/);
  assert.doesNotMatch(input, /workspace|registry_digest|document_count|<planning_state>/);
});

test('Capability Planner boundary input omits the follow-up section once the plan is exhausted', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'boundary',
    inputId: 'announce:delegation-1:1',
    traceId: 'trace-1',
    runId: 'run-1',
    workspace: plannerPromptWorkspace,
    userGoal: '打开示例站点并浏览相关内容。',
    latestUserMessage: null,
    activeDelegation: {
      delegationId: 'delegation-1',
      capability: 'browser',
      task: '确认浏览器可用',
    },
    latestAnnounce: {
      messageId: 'announce-1',
      text: '浏览器已经连接，目标页面可访问。',
      completionReason: 'natural',
    },
    remainingPlan: [],
  } satisfies CapabilityPlannerInput);

  assert.match(input, /^<run_user_goal[^>]*>/);
  assert.match(input, /当前任务：确认浏览器可用/);
  assert.match(input, /浏览器已经连接，目标页面可访问。/);
  assert.doesNotMatch(input, /此前保留的后续任务/);
  assert.doesNotMatch(input, /planner_request_briefing/);
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
