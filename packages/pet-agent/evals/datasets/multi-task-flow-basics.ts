import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type MultiTaskFlowInput = {
  userMessage: string;
  subagentResults: string[];
};

export type MultiTaskFlowExpected = {
  expectedTaskTerms: string[][];
  expectedSearchQueryTerms: string[][];
  expectedDelegationCount: number;
  expectedFinalMode: 'answer';
  expectedResultTerms: string[];
  reason: string;
};

const SUITE = 'agent-multi-task-flow-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/multi-task-flow-basics.ts';

const cases: AgentEvalCase<MultiTaskFlowInput, MultiTaskFlowExpected>[] = [
  {
    id: `${SUITE}.explore-auth-then-implement`,
    name: 'explore-auth-then-implement',
    suite: SUITE,
    tags: ['delegation_control', 'capability_decision', 'capability_planning', 'multi_task_flow', 'context_synthesis'],
    input: {
      userMessage: '先调查 auth 模块的结构和风险，再根据调查结论完成重构。',
      subagentResults: [
        '调查完成：auth/index.ts 存在循环依赖，建议提取 token validation 并保持公开接口。',
        '重构完成：已提取 token validation，移除循环依赖，公开接口保持不变，测试通过。',
      ],
    },
    expected: {
      expectedTaskTerms: [
        ['调查', 'auth', '结构', '风险'],
        ['auth', '重构', 'token validation', '循环依赖'],
      ],
      expectedSearchQueryTerms: [
        ['代码库', 'auth', '调查'],
        ['代码修改', 'auth', '重构'],
      ],
      expectedDelegationCount: 2,
      expectedFinalMode: 'answer',
      expectedResultTerms: ['token validation', '循环依赖', '测试通过'],
      reason: 'Exploration and implementation form separate execution boundaries because the handoff determines the implementation task.',
    },
    metadata: {
      difficulty: 'hard',
      reason: 'Canonical dynamic explore-then-implement loop baseline.',
      source: SOURCE_FILE,
    },
  },
];

export const multiTaskFlowBasicsDataset: AgentEvalDataset<MultiTaskFlowInput, MultiTaskFlowExpected> = {
  name: SUITE,
  description: 'End-to-end multi-task baselines for meaningful capability execution boundaries.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['delegation_control', 'capability_decision', 'capability_planning', 'multi_task_flow', 'context_synthesis'],
  },
};
