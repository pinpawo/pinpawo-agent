import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type EntryExecutionMode = 'answer' | 'direct_task' | 'needs_plan';

export type EntryDecisionInput = {
  userRequest: string;
  conversationContext?: string[];
};

export type EntryDecisionExpected = {
  mode: EntryExecutionMode;
  expectedTaskTerms?: string[];
  expectedBoundaryCount: number;
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
      expectedBoundaryCount: 0,
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
      expectedBoundaryCount: 0,
      reason: 'A provenance-valid completion message already contains the requested fact.',
    },
    metadata: { difficulty: 'easy', reason: 'Explicit completion evidence should not be re-verified.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.intention-is-not-completion-evidence`,
    name: 'intention-is-not-completion-evidence',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '你刚才只是说会提交。请检查仓库并确认这些修改现在是否已经提交。',
      conversationContext: [
        '接下来我会提交当前修改，并确认工作区状态。',
      ],
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['提交'],
      expectedBoundaryCount: 1,
      reason: 'An intention to commit is not evidence that the commit succeeded.',
    },
    metadata: { difficulty: 'hard', reason: 'Observed regression: intent must not be treated as result evidence.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.current-local-state-needs-observation`,
    name: 'current-local-state-needs-observation',
    suite: SUITE,
    tags: ['entry_decision', 'route_control'],
    input: {
      userRequest: '请检查当前仓库，确认现在还有没有未提交的改动。',
      conversationContext: ['之前已经完成代码修改，但没有读取之后的工作区状态。'],
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['未提交'],
      expectedBoundaryCount: 1,
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
      userRequest: '请查询 pinpawo/pinpawo-agent 的 issue #417，确认现在是否仍为 open。',
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['417'],
      expectedBoundaryCount: 1,
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
      userRequest: '请查询 deployment run #8450 的最新状态，确认部署现在是否恢复。',
      conversationContext: [
        '昨天 18:00 查询 deployment run #8421，状态为 failed。',
        '今天 09:30 已重新触发 deployment run #8450，但还没有查询新 run 的状态。',
      ],
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['部署', '8450'],
      expectedBoundaryCount: 1,
      reason: 'The previous observation belongs to an older run; the new deployment run still needs observation.',
    },
    metadata: { difficulty: 'hard', reason: 'Freshness is part of evidence sufficiency.', source: SOURCE_FILE },
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
      expectedBoundaryCount: 0,
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
      userRequest: '计算这份 CSV 的 p95 响应时间并告诉我结果。',
      conversationContext: ['CSV 位于 /workspace/latency.csv，当前还没有计算结果。'],
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['p95'],
      expectedBoundaryCount: 1,
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
      userRequest: '在当前仓库运行 npm test；运行前读取 package.json 确认测试脚本，完成后汇总测试结果。',
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['package.json', 'npm test'],
      expectedBoundaryCount: 1,
      reason: 'Reading the test script, running it, and reporting the result form one workspace execution.',
    },
    metadata: { difficulty: 'medium', reason: 'Preparatory and reporting steps must not force task splitting.', source: SOURCE_FILE },
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
      mode: 'direct_task',
      expectedTaskTerms: ['distribution-worker', 'issue'],
      expectedBoundaryCount: 1,
      reason: 'The demonstrative refers to the latest review, not the older already-published findings.',
    },
    metadata: { difficulty: 'hard', reason: 'Native message recency must resolve the latest review referent.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.explore-before-implementation-needs-plan`,
    name: 'explore-before-implementation-needs-plan',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: '先调查 auth 模块的结构和风险，再根据调查结论完成重构。',
    },
    expected: {
      mode: 'needs_plan',
      expectedBoundaryCount: 2,
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
      userRequest: '分析 PR 的代码风险，并另外用浏览器核对部署文档中的公开配置。',
    },
    expected: {
      mode: 'needs_plan',
      expectedBoundaryCount: 2,
      reason: 'The request contains independently routed and independently verifiable capability work.',
    },
    metadata: { difficulty: 'medium', reason: 'Different capability intents require boundaries.', source: SOURCE_FILE },
  },
];

export const entryDecisionBasicsDataset: AgentEvalDataset<EntryDecisionInput, EntryDecisionExpected> = {
  name: SUITE,
  description: 'Defines run-entry execution mode and task-boundary expectations independently of the current graph schema.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['entry_decision', 'capability_planning', 'context_synthesis'] },
};
