import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildAnswerInvocationMessages } from '../src/agent/orchestrator/runtime/nodes/answer.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import {
  answerBehaviorBasicsDataset,
  type AnswerBehaviorCase,
  type AnswerBehaviorExpectation,
} from './datasets/answer-behavior-basics.ts';
import {
  evaluatePromptGoal,
  type PromptEvalJudge,
} from './prompt-goal-evaluator.ts';

export type AnswerEvalRunResult = {
  output: Record<string, unknown>;
  scores: DecisionContractScore[];
  verdict: string;
  shape: string;
  diagnostics: Record<string, unknown>;
};

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
    judge?: PromptEvalJudge,
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

async function evaluateGoal(
  judge: PromptEvalJudge,
  testCase: AnswerBehaviorCase,
  candidateAnswer: string,
): Promise<{ scores: DecisionContractScore[]; summary: string }> {
  return evaluatePromptGoal({
    judge,
    contract: testCase.expected.contract,
    objective: testCase.expected.objective,
    acceptanceCriteria: testCase.expected.acceptanceCriteria,
    evidence: {
      conversation: testCase.input.messages,
      runtimeContext: testCase.input.delegationOutcome ?? null,
    },
    candidateOutput: { text: candidateAnswer },
  });
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
  const delegationOutcome = testCase.input.delegationOutcome;
  const hasUserGoal = testCase.input.messages.some(({ role }) => role === 'user');
  return buildAnswerInvocationMessages({
    actor,
    workdir: '/workspace',
    runtimeEnvironment: 'Node.js answer eval',
    history: testCase.input.messages.map((message) => message.role === 'user'
      ? new HumanMessage(message.text)
      : new AIMessage(message.text)),
    contextFacts: delegationOutcome?.outcome === 'goal_done'
      ? { mode: 'goal_done', hasUserGoal }
      : delegationOutcome?.outcome === 'user_input_required'
        ? { mode: 'user_input_required', hasUserGoal }
        : { mode: 'direct', hasUserGoal },
    legacyCompletionSource: delegationOutcome?.outcome === 'goal_done'
      ? {
          ...delegationOutcome,
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
      const evaluation = await evaluateGoal(judge ?? { model, config }, testCase, text);
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
