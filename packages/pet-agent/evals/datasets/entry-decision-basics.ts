import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type EntryExecutionMode = 'answer' | 'direct_task' | 'needs_plan';

export type EntryDecisionInput = {
  userRequest: string;
  availableCapabilityIntents: string[];
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
      conversationContext: ['已经完成代码审查，并形成了三个风险结论。'],
      availableCapabilityIntents: ['general', 'codebase_exploration'],
    },
    expected: {
      mode: 'answer',
      expectedBoundaryCount: 0,
      reason: 'The requested answer is already present in conversation context.',
    },
    metadata: { difficulty: 'easy', reason: 'Direct answer at run entry.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.multiple-actions-one-capability-call`,
    name: 'multiple-actions-one-capability-call',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: '读取 package.json 的依赖列表，然后运行 npm test，并告诉我结果。',
      availableCapabilityIntents: ['general_workspace_execution'],
    },
    expected: {
      mode: 'direct_task',
      expectedTaskTerms: ['package.json', 'npm test'],
      expectedBoundaryCount: 1,
      reason: 'Both related actions can be completed naturally in one workspace capability execution.',
    },
    metadata: { difficulty: 'medium', reason: 'Textual steps must not force task splitting.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.explore-before-implementation-needs-plan`,
    name: 'explore-before-implementation-needs-plan',
    suite: SUITE,
    tags: ['entry_decision', 'capability_planning'],
    input: {
      userRequest: '先调查 auth 模块的结构和风险，再根据调查结论完成重构。',
      availableCapabilityIntents: ['codebase_exploration', 'code_modification'],
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
      availableCapabilityIntents: ['code_review', 'browser_research'],
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
