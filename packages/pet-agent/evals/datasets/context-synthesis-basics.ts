import { AgentEvalCase, AgentEvalDataset } from './types.ts';

type ContextSynthesisInput = {
  userMessage: string;
  completedTasks: string[];
  completedResults: string[];
  progressResults?: string[];
};

type ContextSynthesisExpected = {
  expectedMode: 'answer' | 'general' | 'capability';
  expectedAnswerShouldInclude: string[];
  expectedMissingInfo?: string[];
  expectedNeedsMoreWork: boolean;
  reason: string;
};

const SUITE = 'agent-context-synthesis-basics';
const SOURCE_FILE = 'packages/pet-agent/evals/datasets/context-synthesis-basics.ts';

const cases: AgentEvalCase<ContextSynthesisInput, ContextSynthesisExpected>[] = [
  {
    id: `${SUITE}.summarize-completed-search-results`,
    name: 'summarize-completed-search-results',
    suite: SUITE,
    tags: ['context_synthesis', 'delegation_control', 'route_control'],
    input: {
      userMessage: '帮我搜索一下最近的 AI 新闻',
      completedTasks: ['搜索最近的 AI 新闻'],
      completedResults: [
        '已搜索到 5 条最新 AI 新闻：1. OpenAI 发布 GPT-5；2. Google DeepMind 新突破；3. Meta 开源 Llama 4；4. Anthropic 推出 Claude 4；5. 国内大模型竞争加剧。',
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedAnswerShouldInclude: ['OpenAI', 'Google DeepMind', 'Meta', 'Anthropic'],
      expectedNeedsMoreWork: false,
      reason: 'Completed search results are enough to answer with a concise summary.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'The answer node should use completed subagent context directly.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.answer-from-completed-file-read`,
    name: 'answer-from-completed-file-read',
    suite: SUITE,
    tags: ['context_synthesis', 'delegation_control', 'route_control'],
    input: {
      userMessage: '帮我看一下 package.json 里有哪些依赖',
      completedTasks: ['读取 package.json 的依赖列表'],
      completedResults: [
        '项目 package.json 依赖列表：react 19.2.6、typescript ^5.7.0、zod ^3.22.0、@langchain/core ^1.2.1。',
      ],
    },
    expected: {
      expectedMode: 'answer',
      expectedAnswerShouldInclude: ['react', 'typescript', 'zod', '@langchain/core'],
      expectedNeedsMoreWork: false,
      reason: 'The requested dependency information is already available in completed context.',
    },
    metadata: {
      difficulty: 'easy',
      reason: 'File-read results should be summarized rather than reread.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.partial-context-needs-missing-test-result`,
    name: 'partial-context-needs-missing-test-result',
    suite: SUITE,
    tags: ['context_synthesis', 'delegation_control', 'route_control'],
    input: {
      userMessage: '帮我读取 package.json 的依赖列表，然后运行 npm test',
      completedTasks: ['读取 package.json 的依赖列表'],
      completedResults: [
        '已读取 package.json，主要依赖包括 react、typescript、zod、@langchain/core。',
      ],
    },
    expected: {
      expectedMode: 'general',
      expectedAnswerShouldInclude: [],
      expectedMissingInfo: ['npm test result'],
      expectedNeedsMoreWork: true,
      reason: 'Context is enough for the dependency part but not for the explicit test request.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Synthesis must detect missing explicit requirements.',
      source: SOURCE_FILE,
    },
  },
  {
    id: `${SUITE}.progress-is-not-final-answer`,
    name: 'progress-is-not-final-answer',
    suite: SUITE,
    tags: ['context_synthesis', 'delegation_control'],
    input: {
      userMessage: '把 src 下所有 var 改成 const，并告诉我最终结果',
      completedTasks: [],
      completedResults: [],
      progressResults: ['已修改 23 个文件中的 var 声明，但还没有运行校验。'],
    },
    expected: {
      expectedMode: 'general',
      expectedAnswerShouldInclude: [],
      expectedMissingInfo: ['validation result'],
      expectedNeedsMoreWork: true,
      reason: 'A progress update is not a final answer when validation is still missing.',
    },
    metadata: {
      difficulty: 'medium',
      reason: 'Progress context should not be mistaken for task completion.',
      source: SOURCE_FILE,
    },
  },
];

export const contextSynthesisBasicsDataset: AgentEvalDataset<
  ContextSynthesisInput,
  ContextSynthesisExpected
> = {
  name: SUITE,
  description: 'Basic agent cases for answering from completed context and detecting missing information.',
  cases,
  metadata: {
    owner: 'pet-agent',
    areas: ['context_synthesis', 'delegation_control', 'route_control'],
  },
};
