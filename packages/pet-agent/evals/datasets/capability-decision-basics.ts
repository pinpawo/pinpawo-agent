import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type CapabilityDecisionBasicsInput = {
  task: string;
  contextSummary?: string | null;
  availableCapabilities: Array<{
    name: string;
    description: string;
    keywords: string[];
  }>;
  includeGeneralCapability: boolean;
};

export type CapabilityDecisionBasicsExpected = {
  expectedSelection: string;
  expectedCandidateNames: string[];
  reason: string;
};

const SUITE = 'agent-capability-decision-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/capability-decision-basics.ts';

const cases: AgentEvalCase<CapabilityDecisionBasicsInput, CapabilityDecisionBasicsExpected>[] = [
  {
    id: `${SUITE}.auth-structure-routes-to-explore`,
    name: 'auth-structure-routes-to-explore',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '调查 auth 模块当前的代码结构、关键入口和依赖关系，为后续重构形成证据。',
      availableCapabilities: [
        {
          name: 'explore',
          description: 'Read-heavy repository exploration, codebase understanding, evidence gathering, and implementation investigation.',
          keywords: ['代码库理解', '代码结构', '调查', '探索', 'repository exploration'],
        },
        {
          name: 'browser',
          description: 'Open websites and interact with browser pages.',
          keywords: ['浏览器', '网页', '打开'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.explore',
      expectedCandidateNames: ['explore'],
      reason: 'Repository exploration should use the dedicated explore capability.',
    },
    metadata: { difficulty: 'medium', reason: 'Canonical dedicated capability selection.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.pet-post-routes-to-custom-capability`,
    name: 'pet-post-routes-to-custom-capability',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '为小白生成今天的小红书宠物日常草稿。',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖', '小红书', '日常草稿'],
        },
        {
          name: 'browser',
          description: 'Open websites and inspect page content.',
          keywords: ['浏览器', '网页', '打开'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.daily_post',
      expectedCandidateNames: ['daily_post'],
      reason: 'The domain capability covers the complete task.',
    },
    metadata: { difficulty: 'easy', reason: 'Positive custom capability selection.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.missing-execution-parameters-keep-capability-match`,
    name: 'missing-execution-parameters-keep-capability-match',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '为小白准备一条宠物日常内容。',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile and obtain ordinary publishing details while executing.',
          keywords: ['宠物日常', '内容创作', '草稿'],
        },
        {
          name: 'browser',
          description: 'Open websites and inspect page content.',
          keywords: ['浏览器', '网页', '打开'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.daily_post',
      expectedCandidateNames: ['daily_post'],
      reason: 'Ordinary execution details do not make a matching executor unavailable.',
    },
    metadata: { difficulty: 'medium', reason: 'Execution details are not executor requirements.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.file-read-falls-back-to-general`,
    name: 'file-read-falls-back-to-general',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '读取 src/index.ts 并返回文件内容。',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.general',
      expectedCandidateNames: [],
      reason: 'An empty custom search can be handled by available general tools.',
    },
    metadata: { difficulty: 'easy', reason: 'Planner selects the general Capability candidate.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.browser-task-routes-to-browser`,
    name: 'browser-task-routes-to-browser',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '用浏览器打开 https://example.com，返回页面标题和主要内容。',
      availableCapabilities: [
        {
          name: 'browser',
          description: 'Open websites, interact with pages, and extract page content.',
          keywords: ['浏览器', '网页', '打开', '页面内容'],
        },
        {
          name: 'explore',
          description: 'Repository exploration and codebase understanding.',
          keywords: ['代码库', '调查', '探索'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.browser',
      expectedCandidateNames: ['browser'],
      reason: 'Interactive browser work is fully covered by the browser capability.',
    },
    metadata: { difficulty: 'easy', reason: 'Browser capability selection.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.false-positive-custom-candidate-uses-general`,
    name: 'false-positive-custom-candidate-uses-general',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '读取并修改 src/index.ts 的导出，然后运行相关测试。',
      availableCapabilities: [
        {
          name: 'code_review',
          description: 'Review an existing src/index.ts change and return comments; it cannot edit files or run tests.',
          keywords: ['src/index.ts', '代码审查'],
        },
      ],
      includeGeneralCapability: true,
    },
    expected: {
      expectedSelection: 'capability.general',
      expectedCandidateNames: ['code_review'],
      reason: 'Candidate retrieval is not proof that the candidate can execute the complete task.',
    },
    metadata: { difficulty: 'hard', reason: 'Reject a retrieved but incomplete custom executor.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.false-positive-custom-candidate-is-unavailable`,
    name: 'false-positive-custom-candidate-is-unavailable',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '读取并修改 src/index.ts 的导出，然后运行相关测试。',
      availableCapabilities: [
        {
          name: 'code_review',
          description: 'Review an existing src/index.ts change and return comments; it cannot edit files or run tests.',
          keywords: ['src/index.ts', '代码审查'],
        },
      ],
      includeGeneralCapability: false,
    },
    expected: {
      expectedSelection: 'unavailable',
      expectedCandidateNames: ['code_review'],
      reason: 'No supplied executor can perform the complete task.',
    },
    metadata: { difficulty: 'hard', reason: 'Explicit unavailable selection after candidate retrieval.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.no-executor-is-unavailable`,
    name: 'no-executor-is-unavailable',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '在团队日历中创建明天下午三点的发布复盘会议。',
      availableCapabilities: [
        {
          name: 'browser',
          description: 'Open websites, interact with pages, and extract page content.',
          keywords: ['浏览器', '网页', '打开', '页面内容'],
        },
      ],
      includeGeneralCapability: false,
    },
    expected: {
      expectedSelection: 'unavailable',
      expectedCandidateNames: [],
      reason: 'No matching custom capability or general executor is available.',
    },
    metadata: { difficulty: 'medium', reason: 'Deterministic unavailable fallback.', source: SOURCE_FILE },
  },
];

export const capabilityDecisionBasicsDataset: AgentEvalDataset<
  CapabilityDecisionBasicsInput,
  CapabilityDecisionBasicsExpected
> = {
  name: SUITE,
  description: 'Evaluates capability search plus executor selection from the current task and actual runtime availability.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['capability_search', 'capability_decision'],
  },
};
