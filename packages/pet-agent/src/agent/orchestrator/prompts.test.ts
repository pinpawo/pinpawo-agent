import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import {
  buildAnswerSystemPrompt,
  buildCapabilityArtifactContext,
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildPreparedRequestContext,
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
  buildSubagentAnnounceContext,
  buildTaskDecisionInput,
  buildTaskPlanDraftContext,
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
    recentAnnounces: [],
    contextSummaries: ['更早任务摘要：已完成删除旧 pet-bot，PR 已打开，待修 router context。'],
  });

  assert.match(requestContext, /<user_intent_context>/);
  assert.match(requestContext, /<context_summaries source="compaction" role="context">/);
  assert.match(requestContext, /更早任务摘要：已完成删除旧 pet-bot/);
  assert.match(requestContext, /<recent_messages purpose="coreference">/);
  assert.match(requestContext, /recent-7/);
  assert.doesNotMatch(requestContext, /recent-0/);
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
    recentAnnounces: [],
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

test('task decision prompt owns single-step task birth', () => {
  const prompt = buildTaskDecisionSystemPrompt({
    actor: testActor,
    runDelegationContext: '<run_delegations><none>true</none></run_delegations>',
  });
  const input = buildTaskDecisionInput({
    latestUserRequest: '看 issue #269，再查本地实现，最后总结。',
    recentMessages: recentMessages(1),
    taskPlanDraftContext: buildTaskPlanDraftContext(null),
  });

  assert.match(prompt, /task decision 节点/);
  assert.match(prompt, /单步任务粒度/);
  assert.match(prompt, /不要选择 general\/capability lane/);
  assert.match(prompt, /PR review/);
  assert.match(prompt, /不要只因为出现 URL 就只输出 browser\/url/);
  assert.match(prompt, /plan_draft/);
  assert.match(prompt, /先决定 task 字段/);
  assert.match(prompt, /当前没有上一轮 plan_draft/);
  assert.match(prompt, /plan_draft 返回 null/);
  assert.match(prompt, /不新建后续 task 草案/);
  assert.match(prompt, /plan_draft 在当前没有上一轮 plan_draft 时必须为 null/);
  assert.doesNotMatch(prompt, /仍合理的后续 task 可以沿用/);
  assert.match(input, /<task_decision_input>/);
  assert.doesNotMatch(input, /<task_plan_draft/);
  assert.doesNotMatch(input, /重新规划/);
});

test('task decision prompt maintains existing plan draft only', () => {
  const prompt = buildTaskDecisionSystemPrompt({
    actor: testActor,
    runDelegationContext: '<run_delegations><none>true</none></run_delegations>',
    hasTaskPlanDraft: true,
  });
  const input = buildTaskDecisionInput({
    latestUserRequest: '看 issue #269，再查本地实现，最后总结。',
    recentMessages: recentMessages(1),
    taskPlanDraftContext: buildTaskPlanDraftContext([
      '检索本地实现与 git log',
      '汇总结论',
    ]),
  });

  assert.match(prompt, /参考上一轮 plan_draft/);
  assert.match(prompt, /仍合理的后续 task 可以沿用/);
  assert.match(prompt, /本次 task 之后尚未开始的后续 task/);
  assert.match(prompt, /不输出 patch/);
  assert.doesNotMatch(prompt, /当前没有上一轮 plan_draft/);
  assert.match(input, /<task_decision_input>/);
  assert.match(input, /<task_plan_draft/);
  assert.match(input, /当前单步 task/);
  assert.match(input, /选择下一步 task/);
  assert.doesNotMatch(input, /重新规划/);
  assert.match(input, /检索本地实现与 git log/);
});

test('route decision prompt owns capability lane selection', () => {
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
    targetsContext,
  });
  const input = buildRouteDecisionInput({
    pendingTask: {
      task: '在本地仓库检索相关实现。',
      contextSummary: '用户需要判断 issue 是否已实现。',
      searchKeywords: '代码库理解',
    },
  });

  assert.match(prompt, /route decision 节点/);
  assert.match(prompt, /capability\.explore/);
  assert.doesNotMatch(prompt, /delegate_capability\.explore/);
  assert.match(input, /<route_decision_input>/);
  assert.match(input, /在本地仓库检索相关实现/);
});

test('loop-internal router input stays focused on current run announce context', () => {
  const input = buildDelegationOutcomeDecisionInput({
    latestUserRequest: '继续推进',
    currentTaskContext: '<current_delegation>\n  <delegation_id>task-1</delegation_id>\n</current_delegation>',
    subagentAnnounceContext: '<subagent_announce>\n  <result>completed</result>\n</subagent_announce>',
    otherTasksContext: '<other_delegations>\n  <none>true</none>\n</other_delegations>',
    capabilityArtifacts: [],
  });

  assert.doesNotMatch(input, /压缩任务上下文/);
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
  assert.match(prompt, /不接收 plan 草案/);
  assert.match(prompt, /唯一职责/);
});

test('answer prompt owns clarification questions', () => {
  const prompt = buildAnswerSystemPrompt({
    actor: testActor,
  });

  assert.match(prompt, /最终总结、结论、关键依据/);
  assert.match(prompt, /不要把紧邻的执行器\/subagent 结果原文整体复制一遍/);
  assert.match(prompt, /直接向用户提出需要补充或确认的问题/);
  assert.match(prompt, /不要输出 JSON、动作字段/);
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
    latestUserRequest: '请处理代码质量',
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
