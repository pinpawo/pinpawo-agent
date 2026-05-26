// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith dataset: orchestrator route decision eval
 *
 * Each example represents a scenario the orchestrator route node must handle.
 * `inputs` contains the conversation messages and context.
 * `outputs.expected_route` is the correct decision: 'finish' or 'delegate'.
 *
 * Run: npx tsx evals/dataset.ts
 */
import { Client } from 'langsmith';

const DATASET_NAME = 'orchestrator-route-decision';
const DATASET_DESCRIPTION =
  'Evaluates whether the orchestrator correctly decides to finish (reply to user) vs. delegate (call subagent).';

type Example = {
  name: string;
  inputs: {
    user_message: string;
    /** Optional: simulated subagent announce results already in context */
    completed_results?: string[];
    /** Optional: task text for each completed result; defaults to user_message */
    completed_tasks?: string[];
    /** Optional: simulated in-progress subagent announce results already in context */
    progress_results?: string[];
    /** Optional: enable a mock capability registry for capability-search tests */
    capability_pack?: 'pet_content' | 'browser';
    /** Optional: preloaded capability candidates, as if capability_search had already run */
    capability_candidates?: string[];
  };
  outputs: {
    expected_route: 'finish' | 'delegate';
    expected_mode?: 'finish' | 'general' | 'capability';
    expected_phase?: 'initial_request' | 'after_subagent';
    expected_capability_state?: 'unavailable' | 'search_available' | 'candidates_available' | 'search_exhausted';
    expected_active_capability?: string | null;
    expected_capability_candidates_include?: string[];
    expected_capability_candidates_empty?: boolean;
    expected_capability_search_query_terms?: string[];
    /** Brief explanation for reviewers */
    reason: string;
  };
};

const examples: Example[] = [
  // ── Should finish: simple questions ──
  {
    name: 'greeting',
    inputs: { user_message: '你好' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'Simple greeting — no tool needed, reply directly.',
    },
  },
  {
    name: 'chitchat',
    inputs: { user_message: '今天想聊点轻松的，你陪我说会儿话吧' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'Casual chat — no delegated capability is needed.',
    },
  },
  {
    name: 'opinion-question',
    inputs: { user_message: '你觉得猫和狗哪个更可爱？' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'Subjective question — no tool execution needed.',
    },
  },
  {
    name: 'self-introduction',
    inputs: { user_message: '你是谁？介绍一下你自己' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'Self-introduction — orchestrator knows its own identity.',
    },
  },
  {
    name: 'simple-knowledge',
    inputs: { user_message: '地球到月球有多远？' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'General knowledge question — no tool needed.',
    },
  },

  // ── Should finish: result already available ──
  {
    name: 'result-already-sufficient',
    inputs: {
      user_message: '帮我搜索一下最近的AI新闻',
      completed_results: [
        '已搜索到 5 条最新 AI 新闻：\n1. OpenAI 发布 GPT-5\n2. Google DeepMind 新突破\n3. Meta 开源 Llama 4\n4. Anthropic 推出 Claude 4\n5. 国内大模型竞争加剧',
      ],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      reason: 'Search results already returned by subagent — should summarize and finish.',
    },
  },
  {
    name: 'task-done-no-extras',
    inputs: {
      user_message: '帮我查一下这个项目的package.json里有哪些依赖',
      completed_results: [
        '项目 package.json 依赖列表：\n- react: 19.1.0\n- expo: ^52.0.0\n- typescript: ^5.7.0\n共 12 个依赖项。',
      ],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      reason: 'Task fully completed — present result, do not add unnecessary verification.',
    },
  },
  {
    name: 'browser-result-already-sufficient',
    inputs: {
      user_message: '打开小红书探索页看看今天有什么热门内容',
      completed_tasks: [
        '在浏览器中打开小红书探索页面（https://www.xiaohongshu.com/explore），查看今天有什么热门新闻或热门内容。',
      ],
      completed_results: [
        '已打开小红书探索页并提取到热门内容：宠物日常、春季出游、家居收纳、穿搭分享。可以基于这些方向继续选题。',
      ],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      reason: 'Browser subagent already completed the requested observation — route should not repeat the same browser task.',
    },
  },
  {
    name: 'browser-result-with-capability-candidate-still-finishes',
    inputs: {
      user_message: '你好，再来帮我查一下小红书上今天有什么动态',
      completed_tasks: [
        '打开浏览器，搜索小红书上今天的热门动态/新闻，返回找到的热门动态内容。',
      ],
      completed_results: [
        '已打开小红书发现页并提取到今日热门动态：科技 AI 内容、穿搭分享、春季出游和家居收纳等方向。',
      ],
      capability_pack: 'pet_content',
      capability_candidates: ['daily_post'],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      expected_capability_state: 'unavailable',
      expected_capability_candidates_empty: true,
      reason: 'A stale capability candidate should not turn a completed lookup into a new daily-post task.',
    },
  },

  // ── Should delegate: needs tool execution ──
  {
    name: 'file-read-request',
    inputs: { user_message: '帮我看一下 src/index.ts 的内容' },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      reason: 'Requires file read tool — must delegate to general subagent.',
    },
  },
  {
    name: 'code-modification',
    inputs: { user_message: '帮我把 utils.ts 里的 formatDate 函数改成使用 dayjs' },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      reason: 'Requires reading and editing code — must delegate.',
    },
  },
  {
    name: 'web-search',
    inputs: { user_message: '帮我搜索一下 LangGraph 的最新文档' },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      reason: 'Requires web search tool — must delegate.',
    },
  },
  {
    name: 'browser-open-request',
    inputs: {
      user_message: '用浏览器打开 https://example.com 看看页面标题和主要内容',
      capability_pack: 'browser',
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'capability',
      expected_phase: 'initial_request',
      expected_capability_state: 'candidates_available',
      expected_active_capability: 'browser',
      expected_capability_candidates_include: ['browser'],
      reason: 'Browser-backed page interaction should route to the browser capability, not general tools.',
    },
  },
  {
    name: 'shell-command',
    inputs: { user_message: '运行一下 npm test 看看测试结果' },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      reason: 'Requires shell execution — must delegate.',
    },
  },
  {
    name: 'multi-step-first',
    inputs: { user_message: '帮我重构 auth 模块，先看看现在的代码结构' },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      reason: 'Multi-step task, first step needs file exploration — delegate.',
    },
  },

  // ── Edge cases: should finish despite seeming complex ──
  {
    name: 'explain-concept',
    inputs: { user_message: '解释一下什么是 React hooks 的闭包陷阱' },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      reason: 'Knowledge explanation — no tools needed despite being a technical topic.',
    },
  },
  {
    name: 'result-with-tempting-followup',
    inputs: {
      user_message: '帮我创建一个新的 React 组件',
      completed_results: [
        '已创建组件文件 src/components/NewComponent.tsx，包含基本的函数组件模板、props 类型定义和默认导出。',
      ],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      reason:
        'Component created successfully. Should not auto-add tests, storybook, or barrel exports unless asked.',
    },
  },
  {
    name: 'partial-result-needs-more',
    inputs: {
      user_message: '帮我把所有 var 声明改成 const，并运行 lint 检查',
      progress_results: [
        '已将 src/ 目录下 23 个文件中的 var 声明改为 const。',
      ],
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'after_subagent',
      reason: 'User explicitly asked for both: change vars AND run lint. Lint not done yet.',
    },
  },
  {
    name: 'two-task-first-complete-continue-second',
    inputs: {
      user_message: '帮我读取 package.json 的依赖列表，然后运行 npm test',
      completed_tasks: [
        '读取 package.json 的依赖列表',
      ],
      completed_results: [
        '已读取 package.json，主要依赖包括 react、expo、typescript、zod、@langchain/core。',
      ],
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'after_subagent',
      reason: 'The first explicit task is completed, but the second explicit task (npm test) still needs execution.',
    },
  },
  {
    name: 'two-task-both-complete-finish',
    inputs: {
      user_message: '帮我读取 package.json 的依赖列表，然后运行 npm test',
      completed_tasks: [
        '读取 package.json 的依赖列表',
        '运行 npm test',
      ],
      completed_results: [
        '已读取 package.json，主要依赖包括 react、expo、typescript、zod、@langchain/core。',
        '已运行 npm test，测试全部通过，退出码 0。',
      ],
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'after_subagent',
      reason: 'Both explicit tasks have completed, so route should synthesize the result and finish.',
    },
  },
  {
    name: 'capability-search-needed',
    inputs: {
      user_message: '用宠物发帖能力给小白生成今天的小红书日常草稿',
      capability_pack: 'pet_content',
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'capability',
      expected_phase: 'initial_request',
      expected_capability_state: 'candidates_available',
      expected_active_capability: 'daily_post',
      expected_capability_candidates_include: ['daily_post'],
      expected_capability_search_query_terms: ['宠物', '发帖'],
      reason: 'Business capability registry is available but not injected yet — discovery should search candidates before route delegates.',
    },
  },
  {
    name: 'capability-search-loop-delegates-candidate',
    inputs: {
      user_message: '用宠物发帖能力给小白生成今天的小红书日常草稿',
      capability_pack: 'pet_content',
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'capability',
      expected_phase: 'initial_request',
      expected_capability_state: 'candidates_available',
      expected_active_capability: 'daily_post',
      expected_capability_candidates_include: ['daily_post'],
      expected_capability_search_query_terms: ['宠物', '发帖'],
      reason: 'Full graph should search capability candidates, return to route, then delegate to the matched capability.',
    },
  },
  {
    name: 'capability-candidate-delegate',
    inputs: {
      user_message: '用宠物发帖能力给小白生成今天的小红书日常草稿',
      capability_pack: 'pet_content',
      capability_candidates: ['daily_post'],
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'capability',
      expected_phase: 'initial_request',
      expected_capability_state: 'candidates_available',
      expected_active_capability: 'daily_post',
      expected_capability_candidates_include: ['daily_post'],
      reason: 'Candidate is already injected — route should delegate to that capability.',
    },
  },
  {
    name: 'capability-search-no-match-exhausted',
    inputs: {
      user_message: '用库存盘点能力整理仓库货架清单',
      capability_pack: 'pet_content',
    },
    outputs: {
      expected_route: 'finish',
      expected_mode: 'finish',
      expected_phase: 'initial_request',
      expected_capability_state: 'search_exhausted',
      expected_active_capability: null,
      expected_capability_candidates_empty: true,
      expected_capability_search_query_terms: ['库存', '仓库'],
      reason: 'Capability search should run, find no matching business capability, and avoid delegating to an unavailable capability.',
    },
  },
  {
    name: 'general-wins-over-capability-search',
    inputs: {
      user_message: '帮我看一下 src/features/pets/index.ts 的内容',
      capability_pack: 'pet_content',
    },
    outputs: {
      expected_route: 'delegate',
      expected_mode: 'general',
      expected_phase: 'initial_request',
      expected_capability_state: 'search_available',
      reason: 'File inspection is covered by general tools and should not trigger capability search.',
    },
  },
];

async function main() {
  const client = new Client();

  // Delete existing dataset if present
  try {
    const existing = await client.readDataset({ datasetName: DATASET_NAME });
    if (existing) {
      await client.deleteDataset({ datasetId: existing.id });
      console.log(`Deleted existing dataset: ${DATASET_NAME}`);
    }
  } catch {
    // Dataset doesn't exist — fine
  }

  const dataset = await client.createDataset(DATASET_NAME, {
    description: DATASET_DESCRIPTION,
  });
  console.log(`Created dataset: ${dataset.name} (${dataset.id})`);

  for (const example of examples) {
    await client.createExample({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { name: example.name },
    });
    console.log(`  + ${example.name}`);
  }

  console.log(`\nDone — ${examples.length} examples created.`);
}

main().catch(console.error);
