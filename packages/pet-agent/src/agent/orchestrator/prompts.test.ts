import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { materializeDelegation } from './delegationBriefing';
import {
  buildCapabilityArtifactContext,
  buildCapabilityDecisionInput,
  buildCapabilityDecisionSystemPrompt,
  buildCapabilityDecisionAvailableExecutorsContext,
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from './prompts';

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

test('decision recent messages label delegation briefings as scheduling context', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'general',
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
  const prompt = buildTaskDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: 'ENTRY_OUTPUT_INSTRUCTION',
  });
  const input = buildTaskDecisionInput({
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

test('capability decision keeps task and candidates in the input context', () => {
  const availableExecutorsContext = buildCapabilityDecisionAvailableExecutorsContext({
    generalTools: [],
    capabilityCandidates: [{
      name: 'explore',
      description: '代码库理解和调查。',
      score: 8,
      matchedTerms: ['代码库理解'],
    }],
  });
  const prompt = buildCapabilityDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: 'CAPABILITY_OUTPUT_INSTRUCTION',
  });
  const input = buildCapabilityDecisionInput({
    pendingTask: {
      task: '在本地仓库检索相关实现。',
      contextSummary: '用户需要判断 issue 是否已实现。',
    },
    availableExecutorsContext,
    runtimeContext: buildRuntimeContext('/repo', 'Node 20'),
  });

  assert.match(prompt, /CAPABILITY_OUTPUT_INSTRUCTION/);
  assert.match(input, /<capability_decision_input>/);
  assert.match(input, /在本地仓库检索相关实现/);
  assert.match(input, /capability\.explore/);
  assert.match(input, /<available_executors role="fact" source="runtime">/);
  assert.match(input, /<runtime_context/);
  assert.doesNotMatch(input, /search_keywords|matchedTerms|匹配词/);
  assert.doesNotMatch(prompt, /在本地仓库检索相关实现|capability\.explore|\/repo/);
});

test('capability planner keeps planning state in the input context', () => {
  const prompt = buildCapabilityPlanningDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: 'PLANNER_OUTPUT_INSTRUCTION',
  });
  const input = buildCapabilityPlanningDecisionInput({
    mode: 'boundary',
    userIntentContext: '<user_intent_context>重构 auth</user_intent_context>',
    completedTasks: [{
      objective: '调查 auth',
      result: '发现 token validation 循环依赖。',
    }, {
      objective: '确认公开接口约束',
      result: '现有公开接口必须保持兼容。',
    }],
    remainingPlan: [{ objective: '根据调查重构 auth', capabilityIntent: 'code_modification' }],
    latestHandoff: '发现 token validation 循环依赖。',
    capabilityRegistryContext: 'explore: codebase exploration',
  });
  assert.match(prompt, /PLANNER_OUTPUT_INSTRUCTION/);
  assert.match(input, /<mode>boundary<\/mode>/);
  assert.match(input, /<completed_tasks[^]*?调查 auth[^]*?token validation[^]*?<\/completed_tasks>/);
  assert.match(input, /<completed_tasks[^]*?确认公开接口约束[^]*?保持兼容[^]*?<\/completed_tasks>/);
  assert.match(input, /token validation/);
  assert.match(input, /code_modification/);
  assert.match(input, /explore: codebase exploration/);
  assert.doesNotMatch(prompt, /token validation|code_modification|explore: codebase exploration/);
});

test('loop-internal router input stays focused on current run announce context', () => {
  const input = buildDelegationOutcomeDecisionInput({
    userIntentContext: '<user_intent_context><recent_messages>先完成调查，再修复。</recent_messages></user_intent_context>',
    currentTaskContext: '<current_delegation>\n  <delegation_id>task-1</delegation_id>\n</current_delegation>',
    subagentAnnounceContext: '<subagent_announce>\n  <result>completed</result>\n</subagent_announce>',
    otherTasksContext: '<other_delegations>\n  <none>true</none>\n</other_delegations>',
    capabilityArtifacts: [],
  });

  assert.doesNotMatch(input, /压缩任务上下文/);
  assert.match(input, /先完成调查，再修复/);
  assert.match(input, /<subagent_announce>/);
});

test('delegation outcome input carries current task context separately', () => {
  const currentTaskContext = buildDelegationOutcomeCurrentTaskContext({
    id: 'task-1',
    lane: 'general',
    task: '修复 lint',
    contextSummary: '用户要求处理代码质量。',
  });
  const otherTasksContext = buildDelegationOutcomeOtherTasksContext([
    {
      id: 'task-1',
      lane: 'general',
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

test('completed subagent announce context includes the full current result text', () => {
  const longResult = [
    '# Vibe Coding 模型排行榜',
    'A'.repeat(1400),
    'END_OF_FULL_RANKING_MARKER',
  ].join('\n\n');
  const context = buildSubagentAnnounceContext({
    lane: 'general',
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
    lane: 'general',
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
    lane: 'general',
    task: '修复 lint',
    contextSummary: null,
  });
  const input = buildDelegationOutcomeDecisionInput({
    userIntentContext: '<user_intent_context><user_request>请处理代码质量</user_request></user_intent_context>',
    currentTaskContext,
    subagentAnnounceContext: buildSubagentAnnounceContext({
      lane: 'general',
      delegationId: 'task-1',
      task: '修复 lint',
      text: '已完成验证。',
    }, 'natural'),
    otherTasksContext: buildDelegationOutcomeOtherTasksContext([], 'task-1'),
    capabilityArtifacts: [],
  });

  assert.equal((input.match(/修复 lint/g) ?? []).length, 1);
});
