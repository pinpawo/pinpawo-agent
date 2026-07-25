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
  capabilityIntent: string | null;
  remainingPlan: Array<{ objective: string; capabilityIntent: string }>;
};

export function buildCapabilityPlanningGoalContract(
  expected: CapabilityPlanningExpected,
): {
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
} {
  return {
    objective: `Produce ${expected.result} at this planning boundary. ${expected.reason}`,
    acceptanceCriteria: [
      ...(expected.result === 'next_task'
        ? [{
            id: 'materialized_task_correct',
            statement: [
              'The next task is the one independently executable current task required at this boundary.',
              'It preserves the required work and incorporates relevant handoff evidence without absorbing future tasks.',
              `Expected anchors: ${(expected.nextTaskTerms ?? []).join(', ')}.`,
            ].join(' '),
          }, {
            id: 'current_capability_intent_correct',
            statement: [
              'The current capability intent describes the kind of ability needed for the materialized task.',
              'It must not select a concrete executor.',
              `Reference ability: ${expected.capabilityIntent ?? 'none'}.`,
            ].join(' '),
          }, {
            id: 'task_boundaries_justified',
            statement: [
              'Each task boundary is justified by a returned result that later work depends on, a different independently executing ability, or a separately useful acceptance result.',
              'Stages one ability can perform continuously toward the same result should remain together.',
              'More than one decomposition may be valid when these conditions are satisfied.',
            ].join(' '),
          }]
        : []),
      ...(expected.remainingPlan.length > 0
        ? [{
            id: 'remaining_plan_objectives_correct',
            statement: [
              'The remaining plan collectively preserves all future work needed to realize the user goal, in execution order.',
              'An intermediate objective is valid when it requires its own execution boundary and the plan still preserves the ultimate outcome it supports.',
              `Expected objective anchors: ${expected.remainingPlan
                .map(({ objectiveTerms }) => objectiveTerms.join(', '))
                .join(' | ')}.`,
            ].join(' '),
          }, {
            id: 'remaining_capability_intents_correct',
            statement: [
              'Each future capability intent semantically describes the ability needed for its objective.',
              'The intents must not choose concrete executors.',
              `Reference abilities: ${expected.remainingPlan
                .map(({ capabilityIntent }) => capabilityIntent)
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
        contract: 'planner.execution-boundary',
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
