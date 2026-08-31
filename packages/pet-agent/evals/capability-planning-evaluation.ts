import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  scoreCapabilityPlanning,
  type DecisionContractScore,
} from './decision-contract-scorers.ts';
import type {
  CapabilityPlanningExpected,
  CapabilityPlanningInput,
} from './datasets/capability-planning-basics.ts';
import {
  evaluatePromptGoal,
  type PromptEvalJudge,
  type PromptGoalAcceptanceCriterion,
} from './prompt-goal-evaluator.ts';

export type CapabilityPlanningEvalOutput = {
  result: string;
  nextTask: string | null;
  capabilityName: string | null;
  remainingPlan: Array<{ capability: string; task: string }>;
};

export function buildCapabilityPlanningMessages(
  messages: CapabilityPlanningInput['messages'],
): BaseMessage[] {
  return messages.map((message) => (
    message.role === 'user'
      ? new HumanMessage(message.content)
      : new AIMessage(message.content)
  ));
}

/**
 * Build canonical history for one Supervisor eval invocation. A Boundary's
 * current result belongs to the private delegation lane and is appended by the
 * runner with announce metadata, so remove one legacy transcript copy of that
 * same result from ordinary main history when present.
 */
export function buildCapabilityPlanningHistoryMessages(
  input: CapabilityPlanningInput,
): BaseMessage[] {
  let currentAnnounceIndex = -1;
  if (input.mode === 'boundary' && input.latestAnnounce) {
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      const message = input.messages[index];
      if (message?.role === 'assistant'
        && message.content.trim() === input.latestAnnounce.trim()) {
        currentAnnounceIndex = index;
        break;
      }
    }
  }
  return buildCapabilityPlanningMessages(
    currentAnnounceIndex < 0
      ? input.messages
      : input.messages.filter((_message, index) => index !== currentAnnounceIndex),
  );
}

export function buildCapabilityPlanningGoalContract(
  expected: CapabilityPlanningExpected,
): {
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
} {
  return {
    objective: `Produce ${expected.result} at this planning boundary. ${expected.reason}`,
    acceptanceCriteria: [
      ...(expected.result === 'execute_plan' || expected.result === 'advance_plan'
        ? [{
            id: 'materialized_task_correct',
            statement: [
              'The next task is the one independently executable current task required at this boundary.',
              'It preserves the required work and incorporates relevant handoff evidence without absorbing future tasks.',
              'It does not repeat work already satisfied by completed tasks or the latest handoff.',
              `Expected anchors: ${(expected.nextTaskTerms ?? []).join(', ')}.`,
            ].join(' '),
          }, ...(expected.capabilityName
            ? [{
                id: 'current_capability_selection_correct',
                statement: `The selected concrete Capability must be ${expected.capabilityName}.`,
              }]
            : []), {
            id: 'task_boundaries_justified',
            statement: [
              'Each task corresponds to a distinct result or change required by the user goal.',
              'A later task is justified when it depends on a prior returned result or requires a different independently executing ability.',
              'Stages one ability can perform continuously toward the same result should remain together.',
            ].join(' '),
          }, ...(expected.result === 'advance_plan' ? [{
            id: 'remaining_plan_change_is_minimal',
            statement: [
              'Revalidate the prior remaining-plan proposal against the user goal, accepted history, and current result.',
              'Keep only independently required work that is not already satisfied; preserve an unaffected task when its responsibility and wording remain accurate.',
              'Do not rewrite tasks merely for style or copy details that the next executor already receives as context.',
            ].join(' '),
          }] : []), {
            id: expected.remainingPlanPolicy === 'optional'
              ? 'future_work_strategy_valid'
              : 'remaining_plan_objectives_correct',
            statement: expected.remainingPlanPolicy === 'optional'
              ? [
                  'The future work may be preserved eagerly as the expected remaining plan, or deferred to Boundary.',
                  'A deferred plan is valid only when the current task is a self-contained evidence or decision boundary that explicitly carries the eventual delivery direction needed to materialize the expected future work from its result.',
                  'It fails when neither a valid remaining task nor that handoff direction preserves the user goal.',
                  `Expected eventual work: ${expected.remainingPlan
                    .map(({ taskTerms, capability }) => `[${capability}] ${taskTerms.join(', ')}`)
                    .join(' | ')}.`,
                ].join(' ')
              : expected.remainingPlan.length > 0
              ? [
                  'The remaining plan collectively preserves all future work needed to realize the user goal, in execution order.',
                  'An intermediate objective is valid when it requires its own execution boundary and the plan still preserves the ultimate outcome it supports.',
                  `Expected task anchors: ${expected.remainingPlan
                    .map(({ taskTerms }) => taskTerms.join(', '))
                    .join(' | ')}.`,
                ].join(' ')
              : 'The remaining plan is empty because the current task covers all work required for the user goal at this boundary.',
          }]
        : []),
      ...(expected.remainingPlan.length > 0
        && expected.remainingPlanPolicy !== 'optional'
        ? [{
            id: 'remaining_capability_selections_correct',
            statement: [
              'Each future task selects the Capability that can execute it.',
              `Expected Capabilities: ${expected.remainingPlan
                .map(({ capability }) => capability)
                .join(' | ')}.`,
            ].join(' '),
          }]
        : []),
    ],
  };
}

export async function evaluateCapabilityPlanningOutput(params: {
  input: CapabilityPlanningInput;
  expected: CapabilityPlanningExpected;
  output: CapabilityPlanningEvalOutput;
  judge: PromptEvalJudge;
}): Promise<{
  scores: DecisionContractScore[];
  evaluationSummary: string | null;
}> {
  const contract = buildCapabilityPlanningGoalContract(params.expected);
  const semanticEvaluation = contract.acceptanceCriteria.length > 0
    ? await evaluatePromptGoal({
        judge: params.judge,
        contract: 'supervisor.execution-boundary',
        objective: contract.objective,
        acceptanceCriteria: contract.acceptanceCriteria,
        evidence: params.input,
        candidateOutput: params.output,
      })
    : null;
  return {
    scores: [
      ...scoreCapabilityPlanning(params.output, params.expected),
      ...(semanticEvaluation?.scores ?? []),
    ],
    evaluationSummary: semanticEvaluation?.summary ?? null,
  };
}
