import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type EntryDecisionMode = 'answer' | 'needs_plan';

export type EntryDecisionInput = {
  userRequest: string;
  conversationContext?: string[];
  conversationMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
};

export type EntryDecisionExpected = {
  mode: EntryDecisionMode;
  reason: string;
};

const SUITE = 'agent-entry-decision-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/entry-decision-basics.ts';

const cases: AgentEvalCase<EntryDecisionInput, EntryDecisionExpected>[] = [
  {
    id: `${SUITE}.answer-from-existing-context`,
    name: 'answer-from-existing-context',
    suite: SUITE,
    tags: ['entry_decision', 'context_synthesis'],
    input: {
      userRequest: '把刚刚的结论用三句话总结一下。',
      conversationContext: [
        '代码审查结论：认证回退缺少超时保护；缓存失效没有监控；发布脚本缺少回滚检查。',
      ],
    },
    expected: {
      mode: 'answer',
      reason: 'The requested answer is already present in conversation context.',
    },
    metadata: { difficulty: 'easy', reason: 'Direct answer at run entry.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.answer-from-explicit-completion-evidence`,
    name: 'answer-from-explicit-completion-evidence',
    suite: SUITE,
    tags: ['entry_decision', 'context_synthesis'],
    input: {
      userRequest: '所以刚才的修改已经提交了吗？',
      conversationContext: [
        '执行结果：修改已经提交，commit 为 a1b2c3d，工作区保持干净。',
      ],
    },
    expected: {
      mode: 'answer',
      reason: 'The main conversation explicitly records the matching completed result.',
    },
    metadata: { difficulty: 'easy', reason: 'Explicit completion evidence should not be re-verified.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.answer-from-stable-model-knowledge`,
    name: 'answer-from-stable-model-knowledge',
    suite: SUITE,
    tags: ['entry_decision', 'context_synthesis'],
    input: {
      userRequest: '用一句话解释 p95 表示什么。',
    },
    expected: {
      mode: 'answer',
      reason: 'Stable conceptual knowledge can be expressed directly without obtaining current external state.',
    },
    metadata: { difficulty: 'medium', reason: 'The route must not over-execute an ordinary explanation.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.intention-is-not-completion-evidence`,
    name: 'intention-is-not-completion-evidence',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '请以仓库现在的实际状态为准，确认刚才的修改最终有没有提交成功。',
      conversationContext: [
        '接下来我会提交当前修改，并确认工作区状态。',
      ],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'An intention to commit is not evidence that the commit succeeded.',
    },
    metadata: { difficulty: 'hard', reason: 'An explicitly reality-grounded question must not treat intent as result evidence.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.current-local-state-needs-observation`,
    name: 'current-local-state-needs-observation',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '现在仓库里还有未提交的改动吗？',
      conversationContext: ['之前已经完成代码修改，但没有读取之后的工作区状态。'],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The current workspace state requires a new read even though the question refers to recent work.',
    },
    metadata: { difficulty: 'medium', reason: 'Read-only current-state checks are still execution.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.current-remote-state-needs-lookup`,
    name: 'current-remote-state-needs-lookup',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '以 GitHub 上的当前状态为准，pinpawo-agent 的 issue #417 现在还是 open 吗？',
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The requested remote state is not present in the conversation and needs a lookup.',
    },
    metadata: { difficulty: 'medium', reason: 'Remote reads are execution when evidence is absent.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.stale-evidence-needs-refresh`,
    name: 'stale-evidence-needs-refresh',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '部署现在恢复了吗？',
      conversationContext: [
        '昨天 18:00 查询 deployment run #8421，状态为 failed。',
        '今天 09:30 已重新触发 deployment run #8450，但还没有查询新 run 的状态。',
      ],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The previous observation belongs to an older run; the new deployment run still needs observation.',
    },
    metadata: { difficulty: 'hard', reason: 'Freshness is part of evidence sufficiency.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.new-input-unblocks-original-goal`,
    name: 'new-input-unblocks-original-goal',
    suite: SUITE,
    tags: ['entry_decision', 'interruption_recovery', 'route_control'],
    input: {
      userRequest: '地址和只读凭证已经补充好了，请继续。',
      conversationContext: [
        '检查环境的公开配置已经完成；要确认实际部署状态，还需要用户补充环境地址和只读凭证。',
      ],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'Newly supplied information removes the blocker but is not the result of the original deployment check.',
    },
    metadata: { difficulty: 'hard', reason: 'A resumed run must continue the original goal after user-owned input arrives.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.clarification-before-execution`,
    name: 'clarification-before-execution',
    suite: SUITE,
    tags: ['entry_decision', 'context_synthesis'],
    input: {
      userRequest: '把其中一个发布掉。',
      conversationContext: ['当前候选项目是 web-console 和 distribution-worker，两者都尚未发布，也没有默认项或其他选择依据。'],
    },
    expected: {
      mode: 'answer',
      reason: 'The target must be clarified before a safe executable task can be formed.',
    },
    metadata: { difficulty: 'medium', reason: 'Clarification is a user-visible answer path, not speculative execution.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.calculation-needs-execution`,
    name: 'calculation-needs-execution',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '这份 CSV 的 p95 响应时间是多少？',
      conversationContext: ['CSV 位于 /workspace/latency.csv，当前还没有计算结果。'],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'Producing the answer requires a new calculation result.',
    },
    metadata: { difficulty: 'medium', reason: 'Computation is execution even without an external write.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.multiple-actions-one-capability-call`,
    name: 'multiple-actions-one-capability-call',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: '当前仓库的测试能通过吗？把实际结果告诉我，以项目现有的测试配置为准。',
    },
    expected: {
      mode: 'needs_plan',
      reason: 'Establishing the project test result is one independently verifiable workspace task.',
    },
    metadata: { difficulty: 'hard', reason: 'One workspace task may require internal preparation without becoming a plan.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.latest-review-overrides-older-published-work`,
    name: 'latest-review-overrides-older-published-work',
    suite: SUITE,
    tags: ['entry_decision', 'context_synthesis'],
    input: {
      userRequest: 'OK，把刚刚这次 review 的三项发现整理成一个 GitHub issue 发出来。',
      conversationContext: [
        '更早的全仓库架构审查已经发布了 10 个 GitHub issues。',
        '刚完成 packages/distribution-worker 专项 review，新发现 Prisma raw SQL 绕过类型安全、模块职责越界和 shared-events 接入缺失；这些发现尚未发布 issue。',
      ],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The demonstrative refers to the latest review, not the older already-published findings.',
    },
    metadata: { difficulty: 'hard', reason: 'Native message recency must resolve the latest review referent.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.current-check-ignores-unrelated-pending-request`,
    name: 'current-check-ignores-unrelated-pending-request',
    suite: SUITE,
    tags: ['entry_decision', 'route_control', 'context_synthesis'],
    input: {
      userRequest: 'OK，然后检查一下目前本周工作清单中 Issue 发布的情况。注意只是一次检查，不要发新的。',
      conversationMessages: [{
        role: 'user',
        content: '你消化下当前的 wiki 内容，然后帮我看下本周各个仓库的工作完成情况。',
      }, {
        role: 'assistant',
        content: '本周工作完成情况已整理：多个仓库的 Issue 和 PR 状态已核查，后续可按需要继续安排或发布相关工作项。',
      }, {
        role: 'user',
        content: '在 qban-ai-agents 仓库中创建一个 GitHub Issue，标题为「主动感知 MVP：预计算+事件触发方案设计」。',
      }, {
        role: 'assistant',
        content: 'Issue 已创建：https://github.com/aisouls/qban-ai-agents/issues/431。',
      }, {
        role: 'user',
        content: 'OK，你帮我发到钉钉的群里。把这个 issue 的链接。',
      }],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The latest request explicitly scopes work to a current read-only Issue check. The earlier unfulfilled DingTalk send request must not be resumed, and earlier summaries do not provide the new Issue observation.',
    },
    metadata: { difficulty: 'hard', reason: 'Regression distilled from a production answer trace: long history must not turn a current status check into a direct answer or revive the earlier DingTalk send request.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.explore-before-implementation-needs-plan`,
    name: 'explore-before-implementation-needs-plan',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: '把 auth 模块重构一下，不过先弄清楚它现在的结构和风险，方案按实际情况定。',
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The exploration handoff determines the later implementation task.',
    },
    metadata: { difficulty: 'hard', reason: 'Dynamic explore-then-materialize planning.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.independent-deliverables-need-plan`,
    name: 'independent-deliverables-need-plan',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: 'PR #450 有哪些代码风险？部署文档里列出的公开配置也和实际页面一致吗？',
      conversationContext: [
        '当前讨论对象是 pinpawo/pinpawo-agent 的 PR #450；部署文档和实际页面的地址已经在运行环境中配置。',
      ],
    },
    expected: {
      mode: 'needs_plan',
      reason: 'The request contains independently routed and independently verifiable capability work.',
    },
    metadata: { difficulty: 'medium', reason: 'Different capability intents require boundaries.', source: SOURCE_FILE },
  },
];

export const entryDecisionBasicsDataset: AgentEvalDataset<EntryDecisionInput, EntryDecisionExpected> = {
  name: SUITE,
  description: 'Defines the run-entry result-availability gate: answer from existing evidence or invoke the Capability Planner for new results.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['entry_decision', 'route_control', 'context_synthesis'] },
};
