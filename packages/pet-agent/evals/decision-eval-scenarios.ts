import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildEntryAnswerSystemPrompt } from '../src/agent/orchestrator/prompts/answer.ts';
import { PLAN_REQUEST_TOOL_NAME } from '../src/agent/orchestrator/runtime/nodes/entryAnswer.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type { PromptEvalJudge } from './prompt-goal-evaluator.ts';

export type DecisionEvalTarget = 'entry_answer';

export type RenderedDecisionPrompt = {
  system: string;
  input: string;
  conversationMessages?: BaseMessage[];
};

export type DecisionEvalRunResult = {
  output: Record<string, unknown>;
  scores: DecisionContractScore[];
  verdict: string;
  shape: string;
  diagnostics?: Record<string, unknown>;
};

export type DecisionEvalScenario = {
  target: DecisionEvalTarget;
  contract: 'entry_answer.route';
  objective: string;
  datasetName: string;
  caseId: string;
  caseName: string;
  expectedSummary: string;
  render(method?: StructuredOutputMethod): RenderedDecisionPrompt;
  run(
    model: AgentModels['act'],
    method?: StructuredOutputMethod,
    config?: RunnableConfig,
    judge?: PromptEvalJudge,
  ): Promise<DecisionEvalRunResult>;
};

const DATASET_NAME = 'agent-entry-answer-routing';
type EntryAnswerEvalCase = {
  name: string;
  messages: readonly {
    role: 'user' | 'assistant';
    text: string;
  }[];
  expectedRoute: 'answer' | 'plan_request';
};

const ENTRY_ANSWER_CASES: readonly EntryAnswerEvalCase[] = [
  {
    name: 'direct-answer-arithmetic',
    messages: [{ role: 'user', text: '只回答这个问题：2 + 3 等于多少？' }],
    expectedRoute: 'answer',
  },
  {
    name: 'trace-pr-review-follow-up',
    messages: [
      { role: 'user', text: '帮我 review PR #659 的方案。' },
      {
        role: 'assistant',
        text: '现有方案通过 Goal Creation 生成独立目标，但一次普通生成容易偏离固定职责。可以把 Answer 前置，让它直接回答或交给 Planner。',
      },
      { role: 'user', text: '你有什么更优的解决方案，或者想法么？' },
    ],
    expectedRoute: 'answer',
  },
  {
    name: 'clarification-stays-in-answer',
    messages: [{ role: 'user', text: '把那个配置改一下。' }],
    expectedRoute: 'answer',
  },
  {
    name: 'repository-task-enters-planner',
    messages: [{ role: 'user', text: '读取仓库文件，修复当前 TypeScript 错误并运行测试。' }],
    expectedRoute: 'plan_request',
  },
];

const actor = {
  petId: 'entry-answer-eval',
  userId: 'eval-user',
  name: 'entry-answer-eval',
  personality: null,
  stage: null,
  species: null,
};

const planRequest = tool(async () => '', {
  name: PLAN_REQUEST_TOOL_NAME,
  description: 'Hand the current user request to the Capability Planner when satisfying it requires any tool, external capability, or task execution. This control action takes no arguments.',
  schema: z.object({}).strict(),
});

function renderMessages(prompt: RenderedDecisionPrompt) {
  return [
    new SystemMessage(prompt.system),
    ...(prompt.input ? [new HumanMessage(prompt.input)] : []),
    ...(prompt.conversationMessages ?? []),
  ];
}

function entryAnswerScenarios(): DecisionEvalScenario[] {
  return ENTRY_ANSWER_CASES.map((testCase) => {
    const render = (): RenderedDecisionPrompt => ({
      system: buildEntryAnswerSystemPrompt({ actor }),
      input: '',
      conversationMessages: testCase.messages.map((message) => message.role === 'user'
        ? new HumanMessage(message.text)
        : new AIMessage(message.text)),
    });
    return {
      target: 'entry_answer',
      contract: 'entry_answer.route',
      objective: 'Answer from existing conversation context, or request planning when execution is required.',
      datasetName: DATASET_NAME,
      caseId: `${DATASET_NAME}.${testCase.name}`,
      caseName: testCase.name,
      expectedSummary: testCase.expectedRoute,
      render,
      async run(model, _method, config) {
        if (!model.bindTools) {
          throw new Error('Entry Answer eval model must support tool binding.');
        }
        const response = await model.bindTools([planRequest]).invoke(
          renderMessages(render()),
          config,
        );
        if (!AIMessage.isInstance(response)) {
          throw new Error('Entry Answer eval requires an AIMessage response.');
        }
        const text = readMessageText(response).trim();
        const toolCalls = response.tool_calls ?? [];
        const planCalls = toolCalls.filter((call) => call.name === PLAN_REQUEST_TOOL_NAME);
        const observedRoute = planCalls.length > 0 ? 'plan_request' : 'answer';
        const scores: DecisionContractScore[] = [{
          key: 'route_correct',
          statement: `Route this request through ${testCase.expectedRoute}.`,
          evaluator: 'deterministic',
          score: observedRoute === testCase.expectedRoute ? 1 : 0,
          comment: `observed=${observedRoute}`,
        }];
        if (testCase.expectedRoute === 'answer') {
          scores.push({
            key: 'answer_present',
            statement: 'Return a non-empty user-facing answer or clarification question.',
            evaluator: 'deterministic',
            score: text ? 1 : 0,
            comment: `characters=${text.length.toString()}`,
          });
        } else {
          const validPlanCall = planCalls.length === 1
            && Object.keys(planCalls[0]?.args ?? {}).length === 0
            && text.length === 0;
          scores.push({
            key: 'plan_request_shape',
            statement: 'Call plan_request exactly once with an empty argument object and no user-facing text.',
            evaluator: 'deterministic',
            score: validPlanCall ? 1 : 0,
            comment: `calls=${planCalls.length.toString()}`,
          });
        }
        return {
          output: {
            route: observedRoute,
            text,
            toolCalls: toolCalls.map((call) => ({ name: call.name, args: call.args })),
          },
          scores,
          verdict: scores.every(({ score }) => score === 1)
            ? observedRoute
            : 'invalid_route',
          shape: `route=${observedRoute};text=${text.length.toString()};tools=${toolCalls.length.toString()}`,
        };
      },
    };
  });
}

export function getDecisionEvalScenarios(target?: DecisionEvalTarget): DecisionEvalScenario[] {
  const scenarios = entryAnswerScenarios();
  return target ? scenarios.filter((scenario) => scenario.target === target) : scenarios;
}
