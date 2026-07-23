import type { CapabilityDecisionBasicsExpected } from './datasets/capability-decision-basics.ts';
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

function containsTerms(
  key: string,
  statement: string,
  value: string | null | undefined,
  terms: string[],
): DecisionContractScore {
  const missing = terms.filter((term) => !value?.toLowerCase().includes(term.toLowerCase()));
  return {
    key,
    statement,
    evaluator: 'deterministic',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0 ? value ?? '' : `missing=${missing.join(',')}; actual=${value ?? ''}`,
  };
}

export function scoreEntryDecision(
  output: { mode: string; task?: string | null },
  expected: EntryDecisionExpected,
): DecisionContractScore[] {
  return [
    exact(
      'entry_mode_correct',
      `Select ${expected.mode} from the supplied evidence and requested execution shape.`,
      output.mode,
      expected.mode,
    ),
    ...(expected.expectedTaskTerms?.length
      ? [containsTerms(
          'direct_task_content_correct',
          `The direct task preserves the required boundary content: ${expected.expectedTaskTerms.join(', ')}.`,
          output.task,
          expected.expectedTaskTerms,
        )]
      : []),
  ];
}

export function adaptTaskDecisionMode(
  action: 'answer' | 'direct_task' | 'needs_plan',
): 'answer' | 'direct_task' | 'needs_plan' {
  if (action === 'answer' || action === 'needs_plan') return action;
  return 'direct_task';
}

export function scoreCapabilityDecision(
  output: { selectedLane: string },
  expected: CapabilityDecisionBasicsExpected,
): DecisionContractScore[] {
  return [
    exact(
      'capability_selection_correct',
      `Select ${expected.expectedLane} from the executor choices supplied to the model.`,
      output.selectedLane,
      expected.expectedLane,
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
    remainingPlan: Array<{ objective: string; capabilityIntent: string; status: 'concrete' | 'deferred' }>;
  },
  expected: CapabilityPlanningExpected,
  input: CapabilityPlanningInput,
): DecisionContractScore[] {
  const metrics = derivePlanningMetrics(input, output.remainingPlan, output.nextTask && output.capabilityIntent
    ? { objective: output.nextTask, capabilityIntent: output.capabilityIntent }
    : null);
  const remainingPlanMatches = output.remainingPlan.length === expected.remainingPlan.length
    && output.remainingPlan.every((item, index) => {
      const expectedItem = expected.remainingPlan[index];
      return Boolean(expectedItem)
        && item.capabilityIntent === expectedItem.capabilityIntent
        && item.status === expectedItem.status
        && expectedItem.objectiveTerms.every((term) => item.objective.toLowerCase().includes(term.toLowerCase()));
    });
  return [
    exact(
      'planner_result_correct',
      `Return ${expected.result} at this planning boundary.`,
      output.result,
      expected.result,
    ),
    exact(
      'plan_effect_correct',
      `Apply the expected ${expected.planEffect} effect to the current plan.`,
      metrics.planEffect,
      expected.planEffect,
    ),
    {
      key: 'remaining_plan_correct',
      statement: 'Preserve only the valid future tail after the current task.',
      evaluator: 'deterministic',
      score: remainingPlanMatches ? 1 : 0,
      comment: JSON.stringify(output.remainingPlan),
    },
    ...(expected.result === 'next_task'
      ? [
          exact(
            'capability_intent_correct',
            `Assign the materialized task the capability intent ${expected.capabilityIntent ?? 'null'}.`,
            output.capabilityIntent ?? null,
            expected.capabilityIntent ?? null,
          ),
          containsTerms(
            'materialized_task_correct',
            `Materialize a task containing the required evidence: ${(expected.nextTaskTerms ?? []).join(', ')}.`,
            output.nextTask,
            expected.nextTaskTerms ?? [],
          ),
        ]
      : []),
  ];
}

function normalizePlan(plan: Array<{ objective: string; capabilityIntent: string; status: 'concrete' | 'deferred' }>) {
  return plan.map((item) => ({
    objective: item.objective.trim().replace(/\s+/g, ' '),
    capabilityIntent: item.capabilityIntent.trim(),
    status: item.status,
  }));
}

export function derivePlanningMetrics(
  input: CapabilityPlanningInput,
  outputPlan: Array<{ objective: string; capabilityIntent: string; status: 'concrete' | 'deferred' }>,
  materializedTask: { objective: string; capabilityIntent: string } | null = null,
): { planEffect: CapabilityPlanningExpected['planEffect']; rubberStamp: boolean } {
  const before = normalizePlan(input.remainingPlan ?? []);
  const after = normalizePlan([
    ...(materializedTask ? [{ ...materializedTask, status: 'concrete' as const }] : []),
    ...outputPlan,
  ]);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (input.mode === 'entry') {
    return { planEffect: after.length > 0 ? 'created' : 'empty', rubberStamp: false };
  }
  if (unchanged) {
    return { planEffect: before.length > 0 ? 'unchanged' : 'empty', rubberStamp: before.length > 0 };
  }
  if (before.length > 0 && after.length === 0) {
    return { planEffect: 'cancelled', rubberStamp: false };
  }
  return { planEffect: 'revised', rubberStamp: false };
}
