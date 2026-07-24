import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { materializeDelegation } from './delegationBriefing';
import {
  buildAnswerSystemPrompt,
  buildCapabilityArtifactContext,
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
  buildRuntimeContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskDecisionSystemPrompt,
} from './prompts';
import { buildOrchestratorDecisionPromptPrefix } from './prompts/shared';
import {
  buildRouteDecisionOutputInstruction,
  buildCapabilityPlanningDecisionOutputInstruction,
  buildTaskDecisionOutputInstruction,
} from './schemas';

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

test('shared decision prompt prefix owns only the cross-node contract', () => {
  const prompt = buildOrchestratorDecisionPromptPrefix();

  assert.match(prompt, /围绕用户目标运行 task loop/);
  assert.match(prompt, /根据当前调用提供的上下文/);
  assert.match(prompt, /graph 负责推进执行和状态转换/);
  assert.match(prompt, /answer 基于主对话生成用户可见回复/);
  assert.doesNotMatch(prompt, /task loop 流程|术语：/);
  assert.doesNotMatch(prompt, /entryDecision：|capabilityPlanner：|capabilityDecision：|outcomeDecision（决策）/);
  assert.doesNotMatch(prompt, /委派简报|gap_note|handoff/);
});

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

test('entry decision prompt owns execution mode selection', () => {
  const prompt = buildTaskDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: buildTaskDecisionOutputInstruction(),
  });
  const input = buildTaskDecisionInput({
    runDelegationContext: '<run_delegations><none>true</none></run_delegations>',
    runtimeContext: buildRuntimeContext('/repo', 'Node 20'),
  });

  assert.match(prompt, /entry decision 节点/);
  assert.match(prompt, /task loop/);
  assert.match(prompt, /当前阶段：entryDecision/);
  assert.match(prompt, /决策顺序/);
  assert.match(prompt, /answer、direct_task 或 needs_plan/);
  assert.match(prompt, /是否需要新的 capability execution/);
  assert.match(prompt, /读取、查询、检查、计算或操作才能获得当前结果/);
  assert.match(prompt, /主对话已有结果足以回复时，选择 answer/);
  assert.match(prompt, /执行目标是否已经唯一确定/);
  assert.match(prompt, /多个候选且上下文没有选择依据时，选择 answer/);
  assert.match(prompt, /让 answer 询问用户/);
  assert.match(prompt, /是否需要两个或更多彼此独立的 capability executions/);
  assert.match(prompt, /等待前一次 execution 的结果/);
  assert.match(prompt, /分别选择 capability、执行和验收[^]*选择 needs_plan/);
  assert.match(prompt, /其他情况选择 direct_task/);
  assert.match(prompt, /一个 capability execution 可以连续完成相关动作/);
  assert.match(prompt, /同一 capability 对一批同类对象执行相同操作也属于一个 current task/);
  assert.match(prompt, /动作数量和先后顺序不单独产生 plan/);
  assert.doesNotMatch(prompt, /用户在询问已有上下文、最近任务状态或之前结果/);
  assert.doesNotMatch(prompt, /对话中已有足够信息|已有结论直接复用/);
  assert.doesNotMatch(prompt, /plan_draft|task_plan_draft/);
  assert.match(input, /<entry_decision_context role="fact" source="runtime_state" trust="read_only">/);
  assert.match(input, /run_delegation_summaries/);
  assert.match(input, /<runtime_context/);
  assert.match(prompt, /assistant 角色的 compaction context/);
  assert.doesNotMatch(input, /context_summaries/);
  assert.doesNotMatch(input, /<user_request>|<recent_messages>|<recent_subagent_announces>/);
  assert.doesNotMatch(prompt, /\/repo|run_delegations/);
  assert.doesNotMatch(input, /<task_plan_draft/);
  assert.doesNotMatch(input, /capability_artifacts|artifact 短引用/);
  assert.doesNotMatch(input, /<instruction>/);
  assert.doesNotMatch(input, /重新规划/);
});

test('capability decision prompt owns capability selection', () => {
  const targetsContext = buildRouteTargetsContext({
    generalTools: [],
    capabilityCandidates: [{
      name: 'explore',
      description: '代码库理解和调查。',
      score: 8,
      matchedTerms: ['代码库理解'],
    }],
    capabilitySearchAttempted: true,
    capabilitySearchQuery: '代码库理解',
  });
  const prompt = buildRouteDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: buildRouteDecisionOutputInstruction({
      capabilityCandidates: [{ name: 'explore' }],
    }),
  });
  const input = buildRouteDecisionInput({
    pendingTask: {
      task: '在本地仓库检索相关实现。',
      contextSummary: '用户需要判断 issue 是否已实现。',
      searchKeywords: '代码库理解',
    },
    targetsContext,
    runtimeContext: buildRuntimeContext('/repo', 'Node 20'),
  });

  assert.match(prompt, /capability decision 节点/);
  assert.match(prompt, /task loop/);
  assert.match(prompt, /从 route_targets 中选择最适合执行当前 task 的 lane/);
  assert.match(prompt, /匹配的专用 capability 比 general 更合适/);
  assert.match(prompt, /执行参数暂缺不改变匹配结果/);
  assert.doesNotMatch(prompt, /不要改写 task，不要回答用户，不要执行工具/);
  assert.doesNotMatch(prompt, /每次只选择一个执行 capability/);
  assert.doesNotMatch(prompt, /只能从其中选择执行 capability/);
  assert.doesNotMatch(prompt, /capability\.explore/);
  assert.doesNotMatch(prompt, /delegate_capability\.explore/);
  assert.match(input, /<capability_decision_input>/);
  assert.match(input, /在本地仓库检索相关实现/);
  assert.match(input, /capability\.explore/);
  assert.match(input, /<runtime_context/);
  assert.doesNotMatch(input, /只根据下面/);
  assert.doesNotMatch(input, /如果匹配，优先/);
});

test('capability planner prompt owns entry and boundary materialization', () => {
  const prompt = buildCapabilityPlanningDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: buildCapabilityPlanningDecisionOutputInstruction(),
  });
  const input = buildCapabilityPlanningDecisionInput({
    mode: 'boundary',
    userIntentContext: '<user_intent_context>重构 auth</user_intent_context>',
    remainingPlan: [{ objective: '根据调查重构 auth', capabilityIntent: 'code_modification', status: 'deferred' }],
    latestHandoff: '发现 token validation 循环依赖。',
    capabilityRegistryContext: 'explore: codebase exploration',
  });
  assert.match(prompt, /根据 mode 确定现在要执行的任务，并更新后续计划/);
  assert.match(prompt, /mode：[^]*entry：[^]*boundary：[^]*任务规则：/);
  assert.match(prompt, /依赖未来结果的任务保持 deferred/);
  assert.doesNotMatch(prompt, /^result：/m);
  assert.doesNotMatch(prompt, /capability_intent 概括/);
  assert.doesNotMatch(prompt, /具体执行器由 capabilityDecision 选择/);
  assert.doesNotMatch(prompt, /不要选择具体 capability id/);
  assert.doesNotMatch(prompt, /不要验收 announce/);
  assert.match(input, /<mode>boundary<\/mode>/);
  assert.match(input, /token validation/);
  assert.match(input, /code_modification/);
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

test('delegation outcome prompt does not depend on concrete tool context', () => {
  const prompt = buildDelegationOutcomeDecisionSystemPrompt({
    actor: testActor,
    outputInstruction: '输出 JSON。',
  });

  assert.doesNotMatch(prompt, /Delegate targets/);
  assert.doesNotMatch(prompt, /run_shell/);
  assert.doesNotMatch(prompt, /ask_user/);
  assert.doesNotMatch(prompt, /delegate_capability/);
  assert.match(prompt, /task loop/);
  assert.match(prompt, /当前阶段：delegationOutcomeDecision/);
  assert.match(prompt, /current_delegation 定义当前 task 要完成什么/);
  assert.match(prompt, /当前 subagent_announce 提供验收证据/);
  assert.match(prompt, /结合当前 announce 和 other_delegations 判断整个目标/);
  assert.doesNotMatch(prompt, /节点边界/);
  assert.doesNotMatch(prompt, /outcome=continue：/);
  assert.doesNotMatch(prompt, /动态上下文内容/);
});

test('answer prompt owns the user-visible reply', () => {
  const prompt = buildAnswerSystemPrompt({
    actor: testActor,
  });

  assert.match(prompt, /本次面向用户的最终回复/);
  assert.match(prompt, /按照本次回复目标/);
  assert.match(prompt, /主对话中已有的信息/);
  assert.match(prompt, /直接输出回复正文/);
  assert.doesNotMatch(prompt, /orchestrator|handoff|delegation|subagent/);
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
