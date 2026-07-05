import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type DelegationControlInput = {
  userMessage: string;
  completedTasks?: string[];
  completedResults?: string[];
  progressResults?: string[];
  activeTask?: string;
};

type DelegationControlExpected = {
  expectedMode: 'answer' | 'general' | 'capability';
  expectedNextTask?: string | null;
  expectedShouldRepeatCompletedWork: boolean;
  reason: string;
};

const SUITE = 'agent-delegation-control-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/delegation-control-basics.ts';

const cases: AgentEvalCase<DelegationControlInput, DelegationControlExpected>[] = [
  {
    id: `${SUITE}.continue-second-explicit-task`,
    name: 'continue-second-explicit-task',
    suite: SUITE,
    tags: ['delegation_control', 'route_control'],
    input: {
      userMessage: '帮我读取 package.json 的依赖列表，然后运行 npm test',
      completedTasks: ['读取 package.json 的依赖列表'],
      completedResults: [
        '已读取 package.json，主要依赖包括 react、expo、typescript、zod、@langchain/core。',
      ],
    },
    expected: {
      expectedMode: 'general',
      expectedNextTask: '运行 npm test',
      expectedShouldRepeatCompletedWork: false,
      reason: 'The first explicit task is complete, but the second explicit task remains.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Multi-task requests should continue unfinished explicit work only.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.answer-after-all-explicit-tasks-complete`,
    name: 'answer-after-all-explicit-tasks-complete',
    suite: SUITE,
    tags: ['delegation_control', 'context_synthesis', 'route_control'],
    input: {
      userMessage: '帮我读取 package.json 的依赖列表，然后运行 npm test',
      completedTasks: ['读取 package.json 的依赖列表', '运行 npm test'],
      completedResults: [
        '已读取 package.json，主要依赖包括 react、expo、typescript、zod、@langchain/core。',
        '已运行 npm test，测试全部通过，退出码 0。',
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedNextTask: null,
      expectedShouldRepeatCompletedWork: false,
      reason: 'All requested work is complete, so the agent should synthesize and answer.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'Completed multi-task requests should finish instead of delegating again.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.partial-progress-continues-same-task`,
    name: 'partial-progress-continues-same-task',
    suite: SUITE,
    tags: ['delegation_control', 'route_control'],
    input: {
      userMessage: '帮我把所有 var 声明改成 const，并运行 lint 检查',
      activeTask: '把所有 var 声明改成 const，并运行 lint 检查',
      progressResults: ['已将 src/ 目录下 23 个文件中的 var 声明改为 const。'],
    },
    expected: {
      expectedMode: 'general',
      expectedNextTask: '运行 lint 检查',
      expectedShouldRepeatCompletedWork: false,
      reason: 'The edit phase is done but lint has not run yet.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Partial progress should preserve the remaining explicit work.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.avoid-speculative-follow-up`,
    name: 'avoid-speculative-follow-up',
    suite: SUITE,
    tags: ['delegation_control', 'context_synthesis', 'route_control'],
    input: {
      userMessage: '帮我创建一个新的 React 组件',
      completedTasks: ['创建一个新的 React 组件'],
      completedResults: [
        '已创建组件文件 src/components/NewComponent.tsx，包含基本的函数组件模板、props 类型定义和默认导出。',
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedNextTask: null,
      expectedShouldRepeatCompletedWork: false,
      reason: 'The agent should not auto-add tests, stories, or exports unless asked.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Delegation control includes avoiding unrequested follow-up work.',
      source: SOURCE_FILE,
    },
  },
];

export const delegationControlBasicsDataset: AgentEvalDataset<
  DelegationControlInput,
  DelegationControlExpected
> = {
  name: SUITE,
  description: 'Basic agent cases for multi-task delegation, completion detection, and finish bias.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['delegation_control', 'route_control', 'context_synthesis'],
  },
};
