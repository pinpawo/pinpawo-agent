import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import { buildAnswerInvocationMessages } from '../src/agent/orchestrator/runtime/nodes/answer.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import {
  buildOrchestrationDecisionStructuredOutputOptions,
} from '../src/agent/orchestrator/schemas.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import {
  answerBehaviorBasicsDataset,
  type AnswerBehaviorCase,
  type AnswerBehaviorExpectation,
} from './datasets/answer-behavior-basics.ts';

export type AnswerEvalRunResult = {
  output: Record<string, unknown>;
  scores: DecisionContractScore[];
  verdict: string;
  shape: string;
  diagnostics: Record<string, unknown>;
};

export type AnswerEvalJudge = {
  model: AgentModels['act'];
  method?: StructuredOutputMethod;
  config?: RunnableConfig;
};

export class AnswerEvalJudgeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AnswerEvalJudgeError';
    this.cause = cause;
  }
}

export type AnswerEvalScenario = {
  target: 'answer';
  contract: AnswerBehaviorExpectation['contract'];
  objective: string;
  datasetName: string;
  caseId: string;
  caseName: string;
  expectedSummary: string;
  render(): BaseMessage[];
  run(
    model: AgentModels['act'],
    config?: RunnableConfig,
    judge?: AnswerEvalJudge,
  ): Promise<AnswerEvalRunResult>;
};

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'answer-eval',
  personality: null,
  stage: null,
  species: null,
};

function longestSharedSpan(left: string, right: string): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      longest = Math.max(longest, current[rightIndex]);
    }
    previous = current;
  }
  return longest;
}

function buildAnswerGoalEvaluationSchema(criterionIds: string[]) {
  if (criterionIds.length === 0) throw new Error('Answer evaluation requires acceptance criteria.');
  const criteriaShape = Object.fromEntries(criterionIds.map((id) => [id, z.object({
    met: z.boolean(),
    reason: z.string(),
  }).strict()]));
  return z.object({
    criteria: z.object(criteriaShape).strict(),
    summary: z.string(),
  }).strict();
}

export function buildAnswerGoalEvaluatorPrompt(
  method?: StructuredOutputMethod,
  criterionIds: string[] = ['criterion_id'],
): string {
  const instructions = [
    'Evaluate whether a candidate answer achieves the supplied user-visible objective.',
    'Judge every acceptance criterion independently using only the supplied conversation, runtime context, and candidate answer.',
    'Accuracy and grounding require support from the supplied evidence. Treat unsupported additions as a failure when they affect a criterion.',
    'Return exactly one result for every criterion id. Keep each reason concise and evidence-based.',
  ];
  if (method === 'jsonMode') {
    instructions.push(
      'Return one JSON object matching this schema:',
      JSON.stringify(toJsonSchema(buildAnswerGoalEvaluationSchema(criterionIds))),
    );
  }
  return instructions.join('\n');
}

async function evaluateGoal(
  judge: AnswerEvalJudge,
  testCase: AnswerBehaviorCase,
  candidateAnswer: string,
): Promise<{ scores: DecisionContractScore[]; summary: string }> {
  const criterionIds = testCase.expected.acceptanceCriteria.map(({ id }) => id);
  const schema = buildAnswerGoalEvaluationSchema(criterionIds);
  const raw = await judge.model.withStructuredOutput(
    schema,
    buildOrchestrationDecisionStructuredOutputOptions({ method: judge.method }),
  ).invoke([
    new SystemMessage(buildAnswerGoalEvaluatorPrompt(judge.method, criterionIds)),
    new HumanMessage(JSON.stringify({
      contract: testCase.expected.contract,
      objective: testCase.expected.objective,
      acceptanceCriteria: testCase.expected.acceptanceCriteria,
      conversation: testCase.input.messages,
      runtimeContext: testCase.input.completionContext ?? null,
      candidateAnswer,
    })),
  ], judge.config);
  const evaluation = schema.parse(raw);
  return {
    scores: testCase.expected.acceptanceCriteria.map((criterion) => {
      const result = evaluation.criteria[criterion.id];
      return {
        key: criterion.id,
        statement: criterion.statement,
        evaluator: 'llm-judge',
        score: result.met ? 1 : 0,
        comment: result.reason,
      };
    }),
    summary: evaluation.summary,
  };
}

function collectDiagnostics(
  text: string,
  expected: AnswerBehaviorExpectation,
  priorAssistantText: string,
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = { characters: text.length };
  if (expected.diagnostics?.referenceMaxCharacters !== undefined) {
    diagnostics.referenceMaxCharacters = expected.diagnostics.referenceMaxCharacters;
    diagnostics.withinReferenceLength = text.length <= expected.diagnostics.referenceMaxCharacters;
  }
  if (expected.diagnostics?.comparePriorAssistantText) {
    diagnostics.longestPriorAssistantVerbatimSpan = longestSharedSpan(text, priorAssistantText);
  }
  return diagnostics;
}

function render(testCase: AnswerBehaviorCase): BaseMessage[] {
  return buildAnswerInvocationMessages({
    actor,
    workdir: '/workspace',
    runtimeEnvironment: 'Node.js answer eval',
    history: testCase.input.messages.map((message) => message.role === 'user'
      ? new HumanMessage(message.text)
      : new AIMessage(message.text)),
    completionSource: testCase.input.completionContext
      ? {
          ...testCase.input.completionContext,
          delegationId: 'answer-eval-delegation',
          announceMessageId: 'answer-eval-announce',
        }
      : null,
  });
}

export function getAnswerEvalScenarios(): AnswerEvalScenario[] {
  return answerBehaviorBasicsDataset.cases.map((testCase) => ({
    target: 'answer',
    contract: testCase.expected.contract,
    objective: testCase.expected.objective,
    datasetName: answerBehaviorBasicsDataset.name,
    caseId: testCase.id,
    caseName: testCase.name,
    expectedSummary: testCase.expected.expectedBehavior,
    render: () => render(testCase),
    async run(model, config, judge) {
      const response = await model.invoke(render(testCase), config);
      const text = readMessageText(response).trim();
      const priorAssistantText = testCase.input.messages
        .filter(({ role }) => role === 'assistant')
        .map(({ text: messageText }) => messageText)
        .join('\n');
      const evaluation = await evaluateGoal(judge ?? { model, config }, testCase, text)
        .catch((error: unknown) => {
          throw new AnswerEvalJudgeError(error);
        });
      const diagnostics = collectDiagnostics(text, testCase.expected, priorAssistantText);
      return {
        output: { text },
        scores: evaluation.scores,
        verdict: evaluation.scores.every(({ score }) => score === 1)
          ? testCase.expected.expectedBehavior
          : 'goal_not_achieved',
        shape: `characters=${text.length.toString()}`,
        diagnostics: {
          ...diagnostics,
          evaluationSummary: evaluation.summary,
        },
      };
    },
  }));
}
