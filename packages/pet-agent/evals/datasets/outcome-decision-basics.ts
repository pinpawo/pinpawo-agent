import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type OutcomeDecisionInput = {
  userGoal: string;
  currentTask: string;
  announce: string;
  completedHandoffs?: string[];
};

export type OutcomeDecisionExpected = {
  outcome: 'continue' | 'task_done' | 'goal_done';
  reason: string;
};

const SUITE = 'agent-outcome-decision-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/outcome-decision-basics.ts';

const cases: AgentEvalCase<OutcomeDecisionInput, OutcomeDecisionExpected>[] = [
  {
    id: `${SUITE}.partial-result-continues-current-task`,
    name: 'partial-result-continues-current-task',
    suite: SUITE,
    tags: ['outcome_decision', 'delegation_control'],
    input: {
      userGoal: '确认测试失败原因并修复。',
      currentTask: '运行测试并定位失败原因。',
      announce: '测试已运行，发现两个失败，但尚未定位具体原因。',
    },
    expected: { outcome: 'continue', reason: 'The current task acceptance condition is not met.' },
    metadata: { difficulty: 'easy', reason: 'Incomplete announce.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.current-task-done-defers-next-work`,
    name: 'current-task-done-defers-next-work',
    suite: SUITE,
    tags: ['outcome_decision', 'capability_planning'],
    input: {
      userGoal: '调查 auth 模块，并根据结论完成重构。',
      currentTask: '调查 auth 模块结构、依赖和风险。',
      announce: '调查完成：认证入口集中在 auth/index.ts，主要风险是循环依赖。',
    },
    expected: {
      outcome: 'task_done',
      reason: 'The current task is complete; planner@boundary owns whether and how work continues.',
    },
    metadata: { difficulty: 'medium', reason: 'task_done does not generate the next task.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.goal-clearly-complete`,
    name: 'goal-clearly-complete',
    suite: SUITE,
    tags: ['outcome_decision', 'context_synthesis'],
    input: {
      userGoal: '运行 npm test 并告诉我结果。',
      currentTask: '运行 npm test 并记录结果。',
      announce: 'npm test 已完成，568 项测试全部通过，退出码 0。',
    },
    expected: { outcome: 'goal_done', reason: 'The announce directly and clearly completes the user goal.' },
    metadata: { difficulty: 'easy', reason: 'Goal-complete short circuit.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.other-results-do-not-complete-current-task`,
    name: 'other-results-do-not-complete-current-task',
    suite: SUITE,
    tags: ['outcome_decision', 'delegation_control'],
    input: {
      userGoal: '运行单元测试和集成测试，并汇总结果。',
      currentTask: '运行集成测试并记录结果。',
      announce: '集成测试已经启动，但尚未结束，目前没有最终状态。',
      completedHandoffs: ['单元测试已完成，全部通过。'],
    },
    expected: {
      outcome: 'continue',
      reason: 'A completed sibling task does not replace evidence for the incomplete current task.',
    },
    metadata: { difficulty: 'medium', reason: 'Current-announce evidence boundary.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.required-user-input-stops-autonomous-execution`,
    name: 'required-user-input-stops-autonomous-execution',
    suite: SUITE,
    tags: ['outcome_decision', 'context_synthesis'],
    input: {
      userGoal: '根据我的选择，把报告发送到邮件或项目群。',
      currentTask: '确认发送渠道并发送已经完成的报告。',
      announce: '报告已经完成，但用户尚未选择邮件或项目群，当前无法继续发送。',
    },
    expected: {
      outcome: 'goal_done',
      reason: 'The run must return to the user because autonomous execution cannot continue without their choice.',
    },
    metadata: { difficulty: 'medium', reason: 'User-input stopping boundary.', source: SOURCE_FILE },
  },
];

export const outcomeDecisionBasicsDataset: AgentEvalDataset<OutcomeDecisionInput, OutcomeDecisionExpected> = {
  name: SUITE,
  description: 'Separates current-task acceptance from planning the next capability execution.',
  cases,
  metadata: { owner: 'pet-agent', areas: ['outcome_decision', 'delegation_control', 'capability_planning'] },
};
