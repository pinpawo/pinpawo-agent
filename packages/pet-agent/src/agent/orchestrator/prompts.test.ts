import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { materializeDelegation } from './delegationBriefing';
import {
  buildCapabilityArtifactContext,
  buildPreparedRequestContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildGoalCreationInput,
  buildGoalCreationSystemPrompt,
} from './prompts';
import { buildCapabilityPlannerAgentInput } from './prompts/capabilityPlannerAgent';
import type { CapabilityPlannerInput } from './capabilityPlanner/runner';

function recentMessages(count: number) {
  return Array.from({ length: count }, (_, index) => new HumanMessage(`recent-${index}`));
}

const testActor = {
  petId: 'pet-1',
  userId: 'user-1',
  name: '小白',
  personality: '友好',
  stage: 'adult',
  species: 'cat',
};

test('start-loop router request context includes compaction summaries outside recent message window', () => {
  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '继续推进',
    recentMessages: recentMessages(8),
    contextSummaries: ['更早任务摘要：已完成删除旧 pet-bot，PR 已打开，待修 router context。'],
  });

  assert.match(requestContext, /<user_intent_context>/);
  assert.match(requestContext, /<context_summaries source="compaction" role="context">/);
  assert.match(requestContext, /更早任务摘要：已完成删除旧 pet-bot/);
  assert.match(requestContext, /<recent_messages purpose="coreference">/);
  assert.match(requestContext, /recent-7/);
  assert.doesNotMatch(requestContext, /recent-0/);
});

test('prepared request context does not repeat the current user request in recent messages', () => {
  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '打开小红书',
    recentMessages: [
      new HumanMessage('更早的请求'),
      new HumanMessage('打开小红书'),
    ],
  });

  assert.equal((requestContext.match(/打开小红书/g) ?? []).length, 1);
  assert.match(requestContext, /更早的请求/);
});

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
    userGoal: '打开小红书并浏览相关内容。\n\n浏览器已经连接。',
    latestUserMessage: null,
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
  } satisfies CapabilityPlannerInput);

  assert.match(input, /^<run_user_goal[^>]*>/);
  assert.match(input, /打开小红书并浏览相关内容。/);
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
    userGoal: '打开小红书并浏览相关内容。\n\n浏览器已经连接。',
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
    userGoal: '打开小红书并浏览相关内容。',
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

test('decision recent messages label delegation briefings as scheduling context', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-1',
    task: '只完成任务 A',
    essentialContext: null,
  }).laneMessages;
  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '完成 A 和 B',
    recentMessages: [briefing],
  });

  assert.match(requestContext, /<role>委派简报<\/role>/);
  assert.doesNotMatch(requestContext, /<role>助手<\/role>/);
});

test('request contexts include bounded capability artifact refs', () => {
  const artifactContext = buildCapabilityArtifactContext([
    {
      id: 'artifact-1',
      threadId: 'thread-1',
      capabilityId: 'explore',
      delegationId: 'delegation-1',
      runId: 'turn-1',
      kind: 'report',
      mimeType: 'text/markdown',
      uri: 'capability-artifact://thread/thread-1/delegation/delegation-1/artifact/artifact-1',
      title: 'Issue explore report',
      preview: '已确认 issue explore 的关键文件和下一步。',
      sizeBytes: 1200,
      createdAt: '2026-06-16T00:00:00.000Z',
    },
  ]);

  assert.match(artifactContext, /当前会话 capability artifacts/);
  assert.match(artifactContext, /Issue explore report/);
  assert.match(artifactContext, /capability-artifact:\/\/thread\/thread-1/);

  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '继续刚才的探索',
    recentMessages: [],
    capabilityArtifacts: [{
      id: 'artifact-1',
      threadId: 'thread-1',
      capabilityId: 'explore',
      delegationId: 'delegation-1',
      runId: 'turn-1',
      kind: 'report',
      mimeType: 'text/markdown',
      uri: 'capability-artifact://thread/thread-1/delegation/delegation-1/artifact/artifact-1',
      title: 'Issue explore report',
      preview: '已确认 issue explore 的关键文件和下一步。',
      sizeBytes: 1200,
      createdAt: '2026-06-16T00:00:00.000Z',
    }],
  });

  assert.match(requestContext, /<capability_artifacts>/);
  assert.match(requestContext, /当前会话 capability artifacts/);
  assert.match(requestContext, /继续刚才的探索/);
});

test('goal creation keeps runtime state in the input context', () => {
  const prompt = buildGoalCreationSystemPrompt(testActor);
  const input = buildGoalCreationInput({
    runDelegationContext: '<run_delegations><none>true</none></run_delegations>',
    runtimeContext: buildRuntimeContext('/repo', 'Node 20'),
  });

  assert.match(prompt, /User Goal/);
  assert.match(prompt, /不要输出 JSON/);
  assert.match(input, /<goal_creation_context role="fact" source="runtime_state" trust="read_only">/);
  assert.match(input, /run_delegation_summaries/);
  assert.match(input, /<runtime_context/);
  assert.doesNotMatch(input, /context_summaries/);
  assert.doesNotMatch(input, /<user_request>|<recent_messages>|<recent_subagent_announces>/);
  assert.doesNotMatch(prompt, /\/repo|run_delegations/);
  assert.doesNotMatch(input, /<task_plan_draft/);
  assert.doesNotMatch(input, /capability_artifacts|artifact 短引用/);
  assert.doesNotMatch(input, /<instruction>/);
  assert.doesNotMatch(input, /重新规划/);
  assert.doesNotMatch(prompt, /planner_objective|planner_context|route_to_planner/);
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
