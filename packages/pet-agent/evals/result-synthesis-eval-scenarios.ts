import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildResultSynthesisInvocationMessages } from '../src/agent/orchestrator/prompts/resultSynthesis.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import {
  resultSynthesisBasicsDataset,
  type ResultSynthesisCase,
  type ResultSynthesisExpectation,
} from './datasets/result-synthesis-basics.ts';
import {
  evaluatePromptGoal,
  type PromptEvalJudge,
} from './prompt-goal-evaluator.ts';

export type ResultSynthesisEvalRunResult = {
  output: Record<string, unknown>;
  scores: DecisionContractScore[];
  verdict: string;
  shape: string;
  diagnostics: Record<string, unknown>;
};

export type ResultSynthesisEvalScenario = {
  target: 'result_synthesis';
  execution: 'model';
  contract: ResultSynthesisExpectation['contract'];
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
  ): Promise<ResultSynthesisEvalRunResult>;
};

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'result-synthesis-eval',
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
  testCase: ResultSynthesisCase,
  candidateAnswer: string,
): Promise<{ scores: DecisionContractScore[]; summary: string }> {
  return evaluatePromptGoal({
    judge,
    contract: testCase.expected.contract,
    objective: testCase.expected.objective,
    acceptanceCriteria: testCase.expected.acceptanceCriteria,
    evidence: {
      conversation: testCase.input.messages,
      runtimeContext: {
        userRequest: testCase.input.userRequest ?? null,
        acceptedResultCount: testCase.input.acceptedResults.length,
      },
    },
    candidateOutput: { text: candidateAnswer },
  });
}

function collectDiagnostics(
  text: string,
  expected: ResultSynthesisExpectation,
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
  if (
    expected.diagnostics?.referenceMaxPriorAssistantRatio !== undefined
    && priorAssistantText.length > 0
  ) {
    const ratio = text.length / priorAssistantText.length;
    diagnostics.priorAssistantCharacterRatio = ratio;
    diagnostics.referenceMaxPriorAssistantRatio =
      expected.diagnostics.referenceMaxPriorAssistantRatio;
    diagnostics.withinReferencePriorAssistantRatio =
      ratio <= expected.diagnostics.referenceMaxPriorAssistantRatio;
  }
  return diagnostics;
}

function render(testCase: ResultSynthesisCase): BaseMessage[] {
  const userTurns = testCase.input.messages.filter(({ role }) => role === 'user');
  const userRequest = testCase.input.userRequest
    ?? userTurns[userTurns.length - 1]?.text
    ?? null;
  return buildResultSynthesisInvocationMessages({
    actor,
    userRequest,
    acceptedResults: testCase.input.acceptedResults.map(({ task, result }) => ({
      task,
      result,
      artifactRefs: [],
    })),
  });
}

export function getResultSynthesisEvalScenarios(): ResultSynthesisEvalScenario[] {
  return resultSynthesisBasicsDataset.cases.map((testCase) => ({
    target: 'result_synthesis',
    execution: 'model',
    contract: testCase.expected.contract,
    objective: testCase.expected.objective,
    datasetName: resultSynthesisBasicsDataset.name,
    caseId: testCase.id,
    caseName: testCase.name,
    expectedSummary: testCase.expected.expectedBehavior,
    render: () => render(testCase),
    async run(model, config, judge) {
      const text = readMessageText(await model.invoke(render(testCase), config)).trim();
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
