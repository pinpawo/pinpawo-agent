import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  buildGoalCreationInput,
  buildGoalCreationSystemPrompt,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
} from '../src/agent/orchestrator/prompts.ts';
import { USER_GOAL_MAX_CHARS } from '../src/agent/orchestrator/capabilityPlanner/runner.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type { PromptEvalJudge } from './prompt-goal-evaluator.ts';

export type DecisionEvalTarget = 'goal_creation';

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
  contract: 'goal_creation.text';
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

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'decision-eval',
  personality: null,
  stage: null,
  species: null,
};

const DATASET_NAME = 'agent-goal-creation-basics';
const GOAL_CASES = [
  {
    name: 'direct-answer-goal',
    messages: [{ role: 'user', text: '只回答这个问题：2 + 3 等于多少？' }],
    requiredTerms: ['2 + 3'],
  },
  {
    name: 'preserves-path-and-scope',
    messages: [{ role: 'user', text: '只检查 /tmp/project 的 README，不要修改文件。' }],
    requiredTerms: ['/tmp/project', 'README', '不要修改'],
  },
  {
    name: 'resolves-current-coreference',
    messages: [
      { role: 'user', text: '把 #619 和 #621 的 review 问题整理好了。' },
      { role: 'assistant', text: '两个问题都已整理为草案。' },
      { role: 'user', text: '把这些发到 GitHub issue。' },
    ],
    requiredTerms: ['#619', '#621', 'GitHub issue'],
  },
  {
    name: 'keeps-latest-confirmed-scope',
    messages: [
      { role: 'user', text: '重构 Entry、Planner 和 Answer。' },
      { role: 'assistant', text: '最后确认本轮只改 Entry，不动 Planner 和 Answer。' },
      { role: 'user', text: '按最后确认的范围继续。' },
    ],
    requiredTerms: ['Entry', '不动 Planner', 'Answer'],
  },
] as const;

function renderMessages(prompt: RenderedDecisionPrompt) {
  return [
    new SystemMessage(prompt.system),
    new HumanMessage(prompt.input),
    ...(prompt.conversationMessages ?? []),
  ];
}

function goalScenarios(): DecisionEvalScenario[] {
  return GOAL_CASES.map((testCase) => {
    const render = (): RenderedDecisionPrompt => ({
      system: buildGoalCreationSystemPrompt(actor),
      input: buildGoalCreationInput({
        runDelegationContext: buildRunDelegationSummaryContext([]),
        runtimeContext: buildRuntimeContext('/workspace', 'Node.js goal creation eval'),
      }),
      conversationMessages: testCase.messages.map((message) => message.role === 'user'
        ? new HumanMessage(message.text)
        : new AIMessage(message.text)),
    });
    return {
      target: 'goal_creation',
      contract: 'goal_creation.text',
      objective: 'Create a stable text goal that preserves the current request and required context.',
      datasetName: DATASET_NAME,
      caseId: `${DATASET_NAME}.${testCase.name}`,
      caseName: testCase.name,
      expectedSummary: testCase.requiredTerms.join(', '),
      render,
      async run(model, _method, config) {
        const goal = readMessageText(await model.invoke(renderMessages(render()), config)).trim();
        if (!goal || goal.length > USER_GOAL_MAX_CHARS) {
          throw new Error('Goal Creation returned invalid text.');
        }
        const scores: DecisionContractScore[] = testCase.requiredTerms.map((term) => ({
          key: `preserves_${term}`,
          statement: `Preserve the current-goal term: ${term}`,
          evaluator: 'deterministic',
          score: goal.includes(term) ? 1 : 0,
          comment: goal.includes(term) ? 'present' : 'missing',
        }));
        return {
          output: { goal },
          scores,
          verdict: scores.every(({ score }) => score === 1) ? 'valid_goal' : 'missing_context',
          shape: `text=${goal.length.toString()}`,
        };
      },
    };
  });
}

export function getDecisionEvalScenarios(target?: DecisionEvalTarget): DecisionEvalScenario[] {
  const scenarios = goalScenarios();
  return target ? scenarios.filter((scenario) => scenario.target === target) : scenarios;
}
