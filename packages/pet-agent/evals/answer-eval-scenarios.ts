import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildAnswerSystemPrompt } from '../src/agent/orchestrator/prompts.ts';
import { buildDelegationCompletionAnswerContext } from '../src/agent/orchestrator/runtime/nodes/answer.ts';
import { readMessageText } from '../src/agent/orchestrator/utils.ts';
import type { AgentModels } from '../src/types/agent.ts';
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
};

export type AnswerEvalScenario = {
  target: 'answer';
  datasetName: string;
  caseId: string;
  caseName: string;
  expectedSummary: string;
  render(): BaseMessage[];
  run(model: AgentModels['act'], config?: RunnableConfig): Promise<AnswerEvalRunResult>;
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

function scoreText(
  text: string,
  expected: AnswerBehaviorExpectation,
  priorAssistantText: string,
): DecisionContractScore[] {
  const requiredAll = expected.requiredAll ?? [];
  const requiredAny = expected.requiredAny ?? [];
  const forbidden = expected.forbidden ?? [];
  const normalizedText = text.toLowerCase();
  const priorAssistantVerbatimSpan = longestSharedSpan(text, priorAssistantText);
  return [
    {
      key: 'required_content_present',
      score: requiredAll.every((item) => text.includes(item))
        && (requiredAny.length === 0 || requiredAny.some((item) => text.includes(item))) ? 1 : 0,
      comment: 'Answer should contain the case-specific facts or response signal.',
    },
    {
      key: 'forbidden_content_absent',
      score: forbidden.every((item) => !normalizedText.includes(item.toLowerCase())) ? 1 : 0,
      comment: 'Answer should not expose internal terms, claim unperformed work, or replay forbidden result details.',
    },
    {
      key: 'length_within_boundary',
      score: expected.maxCharacters === undefined || text.length <= expected.maxCharacters ? 1 : 0,
      comment: expected.maxCharacters === undefined
        ? 'No case-specific length boundary.'
        : `Answer should stay within ${expected.maxCharacters.toString()} characters.`,
    },
    {
      key: 'prior_result_repetition_correct',
      score: (
        expected.minPriorAssistantVerbatimSpan === undefined
        || priorAssistantVerbatimSpan >= expected.minPriorAssistantVerbatimSpan
      ) && (
        expected.maxPriorAssistantVerbatimSpan === undefined
        || priorAssistantVerbatimSpan <= expected.maxPriorAssistantVerbatimSpan
      ) ? 1 : 0,
      comment: `longest shared span with prior assistant content=${priorAssistantVerbatimSpan.toString()}`,
    },
  ];
}

function render(testCase: AnswerBehaviorCase): BaseMessage[] {
  return [
    new SystemMessage(buildAnswerSystemPrompt({
      actor,
      workdir: '/workspace',
      runtimeEnvironment: 'Node.js answer eval',
    })),
    ...testCase.input.messages.map((message) => message.role === 'user'
      ? new HumanMessage(message.text)
      : new AIMessage(message.text)),
    ...(testCase.input.completionContext
      ? [new SystemMessage(buildDelegationCompletionAnswerContext({
          ...testCase.input.completionContext,
          delegationId: 'answer-eval-delegation',
          announceMessageId: 'answer-eval-announce',
        }))]
      : []),
  ];
}

export function getAnswerEvalScenarios(): AnswerEvalScenario[] {
  return answerBehaviorBasicsDataset.cases.map((testCase) => ({
    target: 'answer',
    datasetName: answerBehaviorBasicsDataset.name,
    caseId: testCase.id,
    caseName: testCase.name,
    expectedSummary: testCase.expected.expectedBehavior,
    render: () => render(testCase),
    async run(model, config) {
      const response = await model.invoke(render(testCase), config);
      const text = readMessageText(response).trim();
      const priorAssistantText = testCase.input.messages
        .filter(({ role }) => role === 'assistant')
        .map(({ text: messageText }) => messageText)
        .join('\n');
      const scores = scoreText(text, testCase.expected, priorAssistantText);
      return {
        output: { text },
        scores,
        verdict: scores.every(({ score }) => score === 1)
          ? testCase.expected.expectedBehavior
          : 'behavior_mismatch',
        shape: `characters=${text.length.toString()}`,
      };
    },
  }));
}
