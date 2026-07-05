import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type CapabilitySearchInput = {
  userMessage: string;
  availableCapabilities: Array<{
    name: string;
    description: string;
    keywords: string[];
  }>;
  generalToolsAvailable?: string[];
  priorCandidates?: string[];
  completedResults?: string[];
};

type CapabilitySearchExpected = {
  expectedMode: 'answer' | 'general' | 'capability';
  expectedCapability?: string | null;
  expectedCandidateNames?: string[];
  expectedSearchQueryTerms?: string[];
  reason: string;
};

const SUITE = 'agent-capability-search-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/capability-search-basics.ts';

const cases: AgentEvalCase<CapabilitySearchInput, CapabilitySearchExpected>[] = [
  {
    id: `${SUITE}.pet-daily-post-capability-match`,
    name: 'pet-daily-post-capability-match',
    suite: SUITE,
    tags: ['capability_search', 'route_control'],
    input: {
      userMessage: '用宠物发帖能力给小白生成今天的小红书日常草稿',
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
    },
    expected: {
      expectedMode: 'capability',
      expectedCapability: 'daily_post',
      expectedCandidateNames: ['daily_post'],
      expectedSearchQueryTerms: ['宠物', '发帖', '小红书'],
      reason: 'A domain pet-posting capability is a better match than general tools.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'Basic positive capability discovery.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.general-file-read-wins`,
    name: 'general-file-read-wins',
    suite: SUITE,
    tags: ['capability_search', 'route_control'],
    input: {
      userMessage: '帮我看一下 src/features/pets/index.ts 的内容',
      generalToolsAvailable: ['read_file', 'search_files'],
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖'],
        },
      ],
    },
    expected: {
      expectedMode: 'general',
      expectedCapability: null,
      reason: 'File inspection is covered by general tools and should not search for a business capability.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'General tool routing should take precedence over unrelated capabilities.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.no-domain-capability-match`,
    name: 'no-domain-capability-match',
    suite: SUITE,
    tags: ['capability_search', 'route_control'],
    input: {
      userMessage: '用库存盘点能力整理仓库货架清单',
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖'],
        },
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedCapability: null,
      expectedCandidateNames: [],
      expectedSearchQueryTerms: ['库存', '仓库'],
      reason: 'No matching capability exists, so the agent should avoid delegating to a fabricated tool.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Negative capability search should be explicit and safe.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.stale-capability-candidate-after-completion`,
    name: 'stale-capability-candidate-after-completion',
    suite: SUITE,
    tags: ['capability_search', 'context_synthesis', 'delegation_control'],
    input: {
      userMessage: '你好，再来帮我查一下小红书上今天有什么动态',
      priorCandidates: ['daily_post'],
      completedResults: [
        '已打开小红书发现页并提取到今日热门动态：科技 AI 内容、穿搭分享、春季出游和家居收纳等方向。',
      ],
      availableCapabilities: [
        {
          name: 'daily_post',
          description: 'Generate daily social media drafts for a pet profile.',
          keywords: ['宠物', '发帖'],
        },
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedCapability: null,
      expectedCandidateNames: [],
      reason: 'A stale candidate should not turn a completed lookup into a new post-generation task.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Capability candidates must be scoped to the current unfinished task.',
      source: SOURCE_FILE,
    },
  },
];

export const capabilitySearchBasicsDataset: AgentEvalDataset<
  CapabilitySearchInput,
  CapabilitySearchExpected
> = {
  name: SUITE,
  description: 'Basic agent cases for capability discovery and capability-vs-general routing.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['capability_search', 'route_control', 'delegation_control', 'context_synthesis'],
  },
};
