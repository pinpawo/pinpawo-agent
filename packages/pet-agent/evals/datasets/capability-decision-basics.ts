import { AgentEvalCase, AgentEvalDataset } from './types.ts';

export type CapabilityDecisionBasicsInput = {
  task: string;
  contextSummary?: string | null;
  baselineSearchQuery: string;
  availableCapabilities: Array<{
    name: string;
    description: string;
    keywords: string[];
  }>;
  generalToolsAvailable?: string[];
};

export type CapabilityDecisionBasicsExpected = {
  expectedLane: string;
  expectedCandidateNames: string[];
  expectedSearchQueryTerms: string[];
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
      baselineSearchQuery: '代码库理解|代码结构|调查|auth 模块|repository exploration',
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
      generalToolsAvailable: ['read_file', 'search_files', 'shell'],
    },
    expected: {
      expectedLane: 'capability.explore',
      expectedCandidateNames: ['explore'],
      expectedSearchQueryTerms: ['代码结构', '调查', 'auth'],
      reason: 'Repository exploration should use the dedicated explore capability instead of the general lane.',
    },
    metadata: { difficulty: 'medium', reason: 'Codebase investigation is the canonical explore route.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.pet-post-routes-to-custom-capability`,
    name: 'pet-post-routes-to-custom-capability',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '为小白生成今天的小红书宠物日常草稿。',
      baselineSearchQuery: '宠物发帖|小红书|日常草稿',
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
      generalToolsAvailable: ['read_file'],
    },
    expected: {
      expectedLane: 'capability.daily_post',
      expectedCandidateNames: ['daily_post'],
      expectedSearchQueryTerms: ['宠物', '小红书'],
      reason: 'A domain capability is a better executor than general tools.',
    },
    metadata: { difficulty: 'easy', reason: 'Positive custom capability route.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.missing-execution-parameters-keep-capability-match`,
    name: 'missing-execution-parameters-keep-capability-match',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '为小白准备一条宠物日常内容。',
      baselineSearchQuery: '宠物日常|内容创作',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile and clarify missing publishing details.',
          keywords: ['宠物日常', '内容创作', '草稿'],
        },
        {
          name: 'browser',
          description: 'Open websites and inspect page content.',
          keywords: ['浏览器', '网页', '打开'],
        },
      ],
      generalToolsAvailable: ['read_file'],
    },
    expected: {
      expectedLane: 'capability.daily_post',
      expectedCandidateNames: ['daily_post'],
      expectedSearchQueryTerms: ['宠物日常', '内容创作'],
      reason: 'Missing platform or publishing details should not hide an otherwise matching capability.',
    },
    metadata: { difficulty: 'medium', reason: 'Capability matching stays stable when execution parameters need clarification.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.file-read-falls-back-to-general`,
    name: 'file-read-falls-back-to-general',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '读取 src/index.ts 并返回文件内容。',
      baselineSearchQuery: '读取文件|TypeScript|src/index.ts',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖'],
        },
      ],
      generalToolsAvailable: ['read_file', 'search_files'],
    },
    expected: {
      expectedLane: 'general',
      expectedCandidateNames: [],
      expectedSearchQueryTerms: ['读取文件', 'index.ts'],
      reason: 'No custom capability matches; built-in general tools can execute the task.',
    },
    metadata: { difficulty: 'easy', reason: 'General fallback after an empty capability search.', source: SOURCE_FILE },
  },
  {
    id: `${SUITE}.browser-task-routes-to-browser`,
    name: 'browser-task-routes-to-browser',
    suite: SUITE,
    tags: ['capability_search', 'capability_decision'],
    input: {
      task: '用浏览器打开 https://example.com，返回页面标题和主要内容。',
      baselineSearchQuery: '浏览器|打开网页|页面内容',
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
      generalToolsAvailable: ['web_search'],
    },
    expected: {
      expectedLane: 'capability.browser',
      expectedCandidateNames: ['browser'],
      expectedSearchQueryTerms: ['浏览器', '网页'],
      reason: 'Interactive browser work should use the browser capability.',
    },
    metadata: { difficulty: 'easy', reason: 'Browser capability route.', source: SOURCE_FILE },
  },
];

export const capabilityDecisionBasicsDataset: AgentEvalDataset<
  CapabilityDecisionBasicsInput,
  CapabilityDecisionBasicsExpected
> = {
  name: SUITE,
  description: 'Evaluates capability resolution from an already-defined current task. baselineSearchQuery exists only for the current production search + routeDecision adapter.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['capability_search', 'capability_decision'],
  },
};
