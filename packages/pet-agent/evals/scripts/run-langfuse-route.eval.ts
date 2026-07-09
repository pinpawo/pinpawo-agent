import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../src/types/agent';
import { orchestratorRouteDataset } from '../datasets/orchestrator-route.ts';
import {
  DATASET_NAME,
  LLM_BASE_URL,
  LLM_MODEL,
  activeCapabilityCorrectness,
  capabilityCandidatesCorrectness,
  capabilitySearchQueryCorrectness,
  capabilityStateCorrectness,
  delegateBias,
  finishBias,
  modeCorrectness,
  phaseCorrectness,
  routeCorrectness,
  target,
} from '../orchestrator-route.eval.ts';
import {
  langfuseFetch,
  resolveLangfuseConfig,
} from './langfuse-api.ts';

type ScoreResult = {
  key: string;
  score: number;
  comment?: string;
};

type EvalRow = {
  id: string;
  name: string;
  suite: string;
  tags: string[];
  ok: boolean;
  durationMs: number;
  scores: ScoreResult[];
  output: Record<string, unknown>;
  error?: string;
};

const scoreKeys = [
  'route_correct',
  'mode_correct',
  'phase_correct',
  'capability_state_correct',
  'active_capability_correct',
  'capability_candidates_correct',
  'capability_search_query_correct',
  'finish_correct',
  'delegate_correct',
];

const evaluators = [
  routeCorrectness,
  modeCorrectness,
  phaseCorrectness,
  capabilityStateCorrectness,
  activeCapabilityCorrectness,
  capabilityCandidatesCorrectness,
  capabilitySearchQueryCorrectness,
  finishBias,
  delegateBias,
];

function splitList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function selectedCases() {
  const requested = new Set(splitList(process.env.EVAL_CASES));
  if (requested.size === 0) return orchestratorRouteDataset.cases;
  return orchestratorRouteDataset.cases.filter((testCase) =>
    requested.has(testCase.id) || requested.has(testCase.name),
  );
}

function compactError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 800);
  }
  return String(error).slice(0, 800);
}

function runEvaluators(
  outputs: Record<string, unknown>,
  referenceOutputs: Record<string, unknown>,
): ScoreResult[] {
  return evaluators.map((evaluator) => evaluator({ outputs, referenceOutputs }));
}

function scorePasses(score: ScoreResult): boolean {
  return score.score === 1;
}

function scoreApplies(score: ScoreResult): boolean {
  return !score.comment?.startsWith('No expected ');
}

function messagesText(messages: unknown[]): string {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return String(message);
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }).join('\n');
}

function readXmlCdataTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`));
  return match?.[1]?.trim() || null;
}

function searchIntentText(text: string): string {
  return readXmlCdataTag(text, 'user_request') ?? text;
}

function chooseCapabilitySearchQuery(text: string): string | null {
  const intent = searchIntentText(text);
  if (/库存|仓库/.test(intent)) return '库存|仓库';
  if (/宠物发帖|小红书日常|日常草稿|daily post/i.test(intent)) return '宠物发帖|小红书日常';
  if (/浏览器|网页|打开 https?:\/\//.test(intent)) return '浏览器|网页|打开';
  if (/调查|探索|代码库理解|注册链路/.test(intent)) return '代码库理解|调查|先探索再决定';
  if (/src\/|package\.json|formatDate|npm test|LangGraph/.test(intent)) return null;
  return null;
}

function chooseDecisionAction(text: string): string {
  if (/delegate_capability\.explore/.test(text) && /继续|limit_reached|capability:explore/.test(text)) {
    return 'delegate_capability.explore';
  }
  if (/delegate_capability\.browser/.test(text) && /打开 https?:\/\/|浏览器|页面标题/.test(text)) {
    return 'delegate_capability.browser';
  }
  if (/delegate_capability\.daily_post/.test(text) && /宠物发帖|小红书日常草稿|daily post/i.test(text)) {
    return 'delegate_capability.daily_post';
  }

  if (/已运行 npm test|测试全部通过/.test(text)) return 'answer';
  if (/项目 package\.json 依赖列表|已读取 package\.json/.test(text) && !/然后运行 npm test/.test(text)) {
    return 'answer';
  }
  const hasCompletedContext = /已搜索到|已读取|已打开|已创建|测试全部通过|已运行 npm test/.test(text);
  if (hasCompletedContext && !/然后运行 npm test/.test(text)) {
    return 'answer';
  }
  if (/已创建组件文件/.test(text)) return 'answer';
  if (/已打开小红书发现页|已打开小红书探索页/.test(text)) return 'answer';
  if (/已将 .*var.*const/.test(text) && /lint|校验/.test(text)) return 'delegate_general';
  if (/读取 package\.json 的依赖列表，然后运行 npm test/.test(text) && !/已运行 npm test/.test(text)) {
    return 'delegate_general';
  }

  if (/库存盘点|库存|仓库/.test(text) && /search_exhausted|没有可选业务 capability|No capability/.test(text)) {
    return 'answer';
  }

  if (/你好|今天想聊点轻松|猫和狗哪个更可爱|你是谁|地球到月球|解释一下/.test(text)) {
    return 'answer';
  }

  if (/宠物发帖|小红书日常|日常草稿|daily post/i.test(text)) {
    return 'delegate_capability.daily_post';
  }
  if (/浏览器|网页|打开 https?:\/\//.test(text)) {
    return 'delegate_capability.browser';
  }
  if (/调查|探索|代码库理解|注册链路/.test(text)) {
    return 'delegate_capability.explore';
  }
  if (/库存盘点|库存|仓库/.test(text)) {
    return 'delegate_general';
  }

  if (/src\/|package\.json|formatDate|npm test|LangGraph|运行一下|重构 auth|读取|搜索|改成|代码结构/.test(text)) {
    return 'delegate_general';
  }

  return 'answer';
}

function chooseRouteLane(text: string): string {
  if (/capability\.explore/.test(text) && /继续|limit_reached|capability:explore|调查|探索|代码库理解|注册链路/.test(text)) {
    return 'capability.explore';
  }
  if (/capability\.browser/.test(text) && /浏览器|网页|打开 https?:\/\//.test(text)) {
    return 'capability.browser';
  }
  if (/capability\.daily_post/.test(text) && /宠物发帖|小红书日常|日常草稿|daily post/i.test(text)) {
    return 'capability.daily_post';
  }
  return 'general';
}

function taskDecisionFromText(text: string) {
  const action = chooseDecisionAction(text);
  if (action === 'answer') {
    return { action };
  }
  return {
    action: 'next_task',
    task: 'mock delegated task',
    context_summary: 'mock route eval context',
    search_keywords: chooseCapabilitySearchQuery(text),
  };
}

function orchestrationDecisionFromText(text: string) {
  const action = chooseDecisionAction(text);
  return action === 'answer'
    ? { action }
    : {
        action,
        task: 'mock delegated task',
        context_summary: 'mock route eval context',
      };
}

function createHeuristicRouteModels(): AgentModels {
  const model = {
    invoke: async () => new AIMessage('mock answer'),
    bindTools: () => ({
      invoke: async (messages: unknown[]) => {
        const query = chooseCapabilitySearchQuery(messagesText(messages));
        return new AIMessage({
          content: '',
          tool_calls: query
            ? [{
                id: `mock_capability_search_${randomUUID()}`,
                name: 'capability_search',
                args: { query },
              }]
            : [],
        });
      },
    }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        const text = messagesText(messages);
        if (/task decision 节点/.test(text)) {
          return taskDecisionFromText(text);
        }
        if (/route decision 节点/.test(text)) {
          return { lane: chooseRouteLane(text) };
        }
        return orchestrationDecisionFromText(text);
      },
    }),
  } as unknown as AgentModels['act'];
  return { act: model, observe: model };
}

function traceIdFor(runName: string, caseId: string): string {
  const slug = `${runName}.${caseId}`
    .replace(/[^a-zA-Z0-9_.:-]/g, '-')
    .slice(0, 160);
  return `${slug}.${randomUUID()}`;
}

async function writeLangfuseResult(params: {
  config: ReturnType<typeof resolveLangfuseConfig>;
  runName: string;
  traceId: string;
  testCase: typeof orchestratorRouteDataset.cases[number];
  row: EvalRow;
}) {
  await langfuseFetch(params.config, '/traces', {
    method: 'POST',
    body: JSON.stringify({
      id: params.traceId,
      name: 'orchestrator-route-eval',
      input: params.testCase.input,
      output: params.row.error
        ? { error: params.row.error, ...params.row.output }
        : params.row.output,
      metadata: {
        runName: params.runName,
        datasetName: DATASET_NAME,
        datasetItemId: params.testCase.id,
        caseName: params.testCase.name,
        tags: params.testCase.tags,
        durationMs: params.row.durationMs,
        ok: params.row.ok,
      },
    }),
  });

  for (const score of params.row.scores) {
    await langfuseFetch(params.config, '/scores', {
      method: 'POST',
      body: JSON.stringify({
        traceId: params.traceId,
        name: score.key,
        value: score.score,
        comment: score.comment,
      }),
    });
  }

  await langfuseFetch(params.config, '/dataset-run-items', {
    method: 'POST',
    body: JSON.stringify({
      runName: params.runName,
      datasetItemId: params.testCase.id,
      traceId: params.traceId,
    }),
  });
}

function printSummary(rows: EvalRow[]) {
  console.log('\n=== Langfuse route eval complete ===');
  console.log(`Cases: ${rows.filter((row) => row.ok).length}/${rows.length} passed`);

  const tags = orchestratorRouteDataset.metadata.areas.filter((tag) =>
    rows.some((row) => row.tags.includes(tag)),
  );
  const knownTags = new Set<string>(tags);
  const unknownTags = [...new Set(rows.flatMap((row) => row.tags))]
    .filter((tag) => !knownTags.has(tag))
    .sort();

  console.log('\nBy example tag:');
  for (const tag of [...tags, ...unknownTags]) {
    const taggedRows = rows.filter((row) => row.tags.includes(tag));
    const passed = taggedRows.filter((row) => row.ok).length;
    console.log(`${tag}: ${passed}/${taggedRows.length} cases passed`);
  }

  console.log('\nBy score dimension:');
  for (const key of scoreKeys) {
    const scores = rows.flatMap((row) => row.scores.filter((score) => score.key === key));
    const applicableScores = scores.filter(scoreApplies);
    const passed = applicableScores.filter(scorePasses).length;
    const skipped = scores.length - applicableScores.length;
    const skippedSuffix = skipped > 0 ? `, ${skipped} not applicable` : '';
    console.log(`${key}: ${passed}/${applicableScores.length} applicable passed${skippedSuffix}`);
  }

  const failed = rows.filter((row) => !row.ok);
  if (failed.length === 0) return;

  console.log('\nFailures:');
  for (const row of failed) {
    const failedScores = row.scores.filter((score) => !scorePasses(score));
    const comments = failedScores.map((score) => `${score.key}: ${score.comment ?? score.score}`).join(' | ');
    console.log(`- ${row.name}: ${row.error ?? comments}`);
  }
}

async function main() {
  const config = resolveLangfuseConfig();
  const cases = selectedCases();
  if (cases.length === 0) {
    throw new Error(`No eval cases selected. EVAL_CASES=${process.env.EVAL_CASES ?? '(unset)'}`);
  }

  const runName = process.env.LANGFUSE_RUN_NAME
    || `orchestrator-route-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const routeModelMode = process.env.EVAL_ROUTE_MODEL === 'llm' ? 'llm' : 'mock';
  const modelOverride = routeModelMode === 'mock' ? createHeuristicRouteModels() : undefined;
  console.log(`Running Langfuse route eval: ${runName}`);
  console.log(`Dataset: ${DATASET_NAME}`);
  console.log(`Model: ${routeModelMode === 'mock' ? 'local-heuristic-mock' : `${LLM_MODEL} @ ${LLM_BASE_URL}`}`);
  console.log(`Langfuse: ${config.baseUrl}`);
  console.log(`Cases: ${cases.length}\n`);

  const rows: EvalRow[] = [];
  for (const testCase of cases) {
    const started = performance.now();
    const traceId = traceIdFor(runName, testCase.id);
    try {
      const output = await target(testCase.input, modelOverride);
      const scores = runEvaluators(output, testCase.expected);
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: scores.every(scorePasses),
        durationMs: Math.round(performance.now() - started),
        scores,
        output,
      };
      await writeLangfuseResult({ config, runName, traceId, testCase, row });
      rows.push(row);
      console.log(`[${row.ok ? 'PASS' : 'FAIL'}] ${testCase.name} (${row.durationMs}ms)`);
    } catch (error) {
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: false,
        durationMs: Math.round(performance.now() - started),
        scores: [{ key: 'run_error', score: 0, comment: compactError(error) }],
        output: {},
        error: compactError(error),
      };
      await writeLangfuseResult({ config, runName, traceId, testCase, row });
      rows.push(row);
      console.log(`[ERROR] ${testCase.name} (${row.durationMs}ms): ${row.error}`);
    }
  }

  printSummary(rows);
  if (rows.some((row) => !row.ok)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
