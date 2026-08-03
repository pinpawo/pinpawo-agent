import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { materializeDelegation } from './delegationBriefing';
import {
  buildCapabilityArtifactContext,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildDelegationOutcomeRemainingPlanContext,
  buildPreparedRequestContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildEntryDecisionInput,
  buildEntryDecisionSystemPrompt,
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

test('Capability Planner planning state excludes main-conversation content', () => {
  const input = buildCapabilityPlannerAgentInput({
    mode: 'boundary',
    workspace: {
      rootPath: '/tmp/capabilities',
      registryDigest: 'a'.repeat(64),
      capabilityNames: ['browser'],
      entries: [{
        capabilityName: 'browser',
        relativePath: 'browser/CAPABILITY.md',
        documentDigest: 'b'.repeat(64),
        provenance: 'authored',
      }],
      reused: false,
    },
    messages: [new HumanMessage('打开小红书')],
    completedTask: '确认浏览器可用',
    completedTaskResult: '浏览器已经连接，目标页面可访问。',
    remainingPlan: [{
      capability: 'browser',
      task: '浏览相关内容',
    }],
  } satisfies CapabilityPlannerInput);

  assert.match(input, /^Planner Context：继续执行状态\n刚完成的任务：确认浏览器可用/);
  assert.match(input, /任务结果摘要：浏览器已经连接，目标页面可访问。/);
  assert.match(input, /- \[browser\] 浏览相关内容/);
  assert.doesNotMatch(input, /打开小红书|workspace|registry_digest|document_count|<planning_state>/);
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

test('entry decision keeps runtime state in the input context', () => {
  const prompt = buildEntryDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: 'ENTRY_OUTPUT_INSTRUCTION',
  });
  const input = buildEntryDecisionInput({
    runDelegationContext: '<run_delegations><none>true</none></run_delegations>',
    runtimeContext: buildRuntimeContext('/repo', 'Node 20'),
  });

  assert.match(prompt, /ENTRY_OUTPUT_INSTRUCTION/);
  assert.match(input, /<entry_decision_context role="fact" source="runtime_state" trust="read_only">/);
  assert.match(input, /run_delegation_summaries/);
  assert.match(input, /<runtime_context/);
  assert.doesNotMatch(input, /context_summaries/);
  assert.doesNotMatch(input, /<user_request>|<recent_messages>|<recent_subagent_announces>/);
  assert.doesNotMatch(prompt, /\/repo|run_delegations/);
  assert.doesNotMatch(input, /<task_plan_draft/);
  assert.doesNotMatch(input, /capability_artifacts|artifact 短引用/);
  assert.doesNotMatch(input, /<instruction>/);
  assert.doesNotMatch(input, /重新规划/);
});

test('loop-internal router input stays focused on current run announce context', () => {
  const input = buildDelegationOutcomeDecisionInput({
    userIntentContext: '<user_intent_context><recent_messages>先完成调查，再修复。</recent_messages></user_intent_context>',
    currentTaskContext: '<current_delegation>\n  <delegation_id>task-1</delegation_id>\n</current_delegation>',
    subagentAnnounceContext: '<subagent_announce>\n  <result>completed</result>\n</subagent_announce>',
    otherTasksContext: '<other_delegations>\n  <none>true</none>\n</other_delegations>',
    remainingPlanContext: buildDelegationOutcomeRemainingPlanContext([]),
    capabilityArtifacts: [],
  });

  assert.doesNotMatch(input, /压缩任务上下文/);
  assert.match(input, /先完成调查，再修复/);
  assert.match(input, /<subagent_announce>/);
});

test('delegation outcome input carries current task context separately', () => {
  const currentTaskContext = buildDelegationOutcomeCurrentTaskContext({
    id: 'task-1',
    lane: 'capability:general',
    task: '修复 lint',
    contextSummary: '用户要求处理代码质量。',
  });
  const otherTasksContext = buildDelegationOutcomeOtherTasksContext([
    {
      id: 'task-1',
      lane: 'capability:general',
      task: '修复 lint',
      status: 'progress',
      resultPreview: null,
    },
    {
      id: 'task-0',
      lane: 'capability:explore',
      task: '调查失败原因',
      status: 'completed',
      resultPreview: '已定位到 lint 配置。',
    },
  ], 'task-1');

  assert.match(currentTaskContext ?? '', /<current_delegation>/);
  assert.match(currentTaskContext ?? '', /<task>\n\s+<!\[CDATA\[\n修复 lint\n\s+\]\]>\n\s+<\/task>/);
  assert.doesNotMatch(currentTaskContext ?? '', /continuation_action/);
  assert.match(otherTasksContext, /<delegation_id>task-0<\/delegation_id>/);
  assert.doesNotMatch(otherTasksContext, /<!\[CDATA\[\n修复 lint\n\s+\]\]>/);
});

test('delegation outcome remaining plan is advisory planning context', () => {
  const prompt = buildDelegationOutcomeDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: 'OUTCOME_OUTPUT_INSTRUCTION',
  });
  assert.match(prompt, /remaining_plan 是 Planner/);
  assert.match(prompt, /为空或非空都不是单独的终态条件/);
  assert.match(prompt, /OUTCOME_OUTPUT_INSTRUCTION/);

  const context = buildDelegationOutcomeRemainingPlanContext([{
    capability: 'general',
    task: '根据检查结果处理对应问题',
  }]);

  assert.match(
    context,
    /<remaining_plan role="planning_context" authority="advisory">/,
  );
  assert.match(context, /根据检查结果处理对应问题/);
  assert.match(context, /<capability>[\s\S]*general/);
  assert.doesNotMatch(context, /role="fact"/);

  const empty = buildDelegationOutcomeRemainingPlanContext([]);
  assert.match(empty, /<none>true<\/none>/);

  const bounded = buildDelegationOutcomeRemainingPlanContext(
    Array.from({ length: 25 }, (_, index) => ({
      capability: 'general',
      task: `future-${index.toString()}`,
    })),
  );
  assert.match(bounded, /<truncated omitted="1" \/>/);
  assert.doesNotMatch(bounded, /future-24/);
});

test('completed subagent announce context includes the full current result text', () => {
  const longResult = [
    '# Vibe Coding 模型排行榜',
    'A'.repeat(1400),
    'END_OF_FULL_RANKING_MARKER',
  ].join('\n\n');
  const context = buildSubagentAnnounceContext({
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

test('delegation outcome input does not duplicate the active task in announce context', () => {
  const currentTaskContext = buildDelegationOutcomeCurrentTaskContext({
    id: 'task-1',
    lane: 'capability:general',
    task: '修复 lint',
    contextSummary: null,
  });
  const input = buildDelegationOutcomeDecisionInput({
    userIntentContext: '<user_intent_context><user_request>请处理代码质量</user_request></user_intent_context>',
    currentTaskContext,
    subagentAnnounceContext: buildSubagentAnnounceContext({
      lane: 'capability:general',
      delegationId: 'task-1',
      task: '修复 lint',
      text: '已完成验证。',
    }, 'natural'),
    otherTasksContext: buildDelegationOutcomeOtherTasksContext([], 'task-1'),
    remainingPlanContext: buildDelegationOutcomeRemainingPlanContext([]),
    capabilityArtifacts: [],
  });

  assert.equal((input.match(/修复 lint/g) ?? []).length, 1);
});
