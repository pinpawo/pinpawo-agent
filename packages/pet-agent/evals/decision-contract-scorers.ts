import type { CapabilityPlanningExpected } from './datasets/capability-planning-basics.ts';
import type { CapabilityPlanningInput } from './datasets/capability-planning-basics.ts';
import type { EntryDecisionExpected } from './datasets/entry-decision-basics.ts';
import type { OutcomeDecisionExpected } from './datasets/outcome-decision-basics.ts';

export type DecisionContractScore = {
  key: string;
  statement: string;
  evaluator: 'deterministic' | 'llm-judge';
  score: 0 | 1;
  comment: string;
};

function exact(
  key: string,
  statement: string,
  actual: unknown,
  expected: unknown,
): DecisionContractScore {
  return {
    key,
    statement,
    evaluator: 'deterministic',
    score: actual === expected ? 1 : 0,
    comment: `expected=${String(expected)}, actual=${String(actual)}`,
  };
}

export function scoreEntryDecision(
  output: { mode: string },
  expected: EntryDecisionExpected,
): DecisionContractScore[] {
  return [
    exact(
      'entry_mode_correct',
      `Select ${expected.mode} for the current user goal and available results.`,
      output.mode,
      expected.mode,
    ),
  ];
}

export function scoreOutcomeDecision(
  output: { outcome?: string },
  expected: OutcomeDecisionExpected,
): DecisionContractScore[] {
  return [
    exact(
      'outcome_correct',
      `Judge the current announce as ${expected.outcome} from current-task and user-goal evidence.`,
      output.outcome,
      expected.outcome,
    ),
  ];
}

export function scoreCapabilityPlanning(
  output: {
    result: string;
    nextTask?: string | null;
    capabilityIntent?: string | null;
    capabilityName?: string | null;
    remainingPlan: Array<{ objective: string; capabilityIntent: string }>;
  },
  expected: CapabilityPlanningExpected,
): DecisionContractScore[] {
  return [
    exact(
      'planner_result_correct',
      `Return ${expected.result} at this planning boundary.`,
      output.result,
      expected.result,
    ),
    ...(expected.capabilityName === undefined
      ? []
      : [exact(
          'planner_capability_correct',
          `Select ${expected.capabilityName} as the concrete Capability.`,
          output.capabilityName,
          expected.capabilityName,
        )]),
    ...(expected.exactRemainingPlanLength === undefined
      ? []
      : [exact(
          'remaining_plan_length_correct',
          `Return exactly ${expected.exactRemainingPlanLength.toString()} future tasks for this case-specific task-boundary contract.`,
          output.remainingPlan.length,
          expected.exactRemainingPlanLength,
        )]),
  ];
}

function normalizePlan(plan: Array<{ objective: string; capabilityIntent: string }>) {
  return plan.map((item) => ({
    objective: item.objective.trim().replace(/\s+/g, ' '),
    capabilityIntent: item.capabilityIntent.trim(),
  }));
}

export function derivePlanningMetrics(
  input: CapabilityPlanningInput,
  outputPlan: Array<{ objective: string; capabilityIntent: string }>,
  materializedTask: { objective: string; capabilityIntent: string } | null = null,
): { planEffect: CapabilityPlanningExpected['planEffect']; rubberStamp: boolean } {
  const before = normalizePlan(input.remainingPlan ?? []);
  const after = normalizePlan([
    ...(materializedTask ? [materializedTask] : []),
    ...outputPlan,
  ]);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (input.mode === 'entry') {
    return { planEffect: after.length > 0 ? 'created' : 'empty', rubberStamp: false };
  }
  if (unchanged) {
    return { planEffect: before.length > 0 ? 'unchanged' : 'empty', rubberStamp: before.length > 0 };
  }
  return { planEffect: 'revised', rubberStamp: false };
}
