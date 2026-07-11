import type { CapabilityDecisionBasicsExpected } from './datasets/capability-decision-basics.ts';
import type { CapabilityPlanningExpected } from './datasets/capability-planning-basics.ts';
import type { EntryDecisionExpected } from './datasets/entry-decision-basics.ts';
import type { OutcomeDecisionExpected } from './datasets/outcome-decision-basics.ts';

export type DecisionContractScore = {
  key: string;
  score: 0 | 1;
  comment: string;
};

function exact(key: string, actual: unknown, expected: unknown): DecisionContractScore {
  return {
    key,
    score: actual === expected ? 1 : 0,
    comment: `expected=${String(expected)}, actual=${String(actual)}`,
  };
}

function containsTerms(key: string, value: string | null | undefined, terms: string[] = []): DecisionContractScore {
  const missing = terms.filter((term) => !value?.toLowerCase().includes(term.toLowerCase()));
  return {
    key,
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0 ? value ?? '' : `missing=${missing.join(',')}; actual=${value ?? ''}`,
  };
}

export function scoreEntryDecision(
  output: { mode: string; task?: string | null; boundaryCount: number },
  expected: EntryDecisionExpected,
): DecisionContractScore[] {
  return [
    exact('entry_mode_correct', output.mode, expected.mode),
    exact('task_boundary_count_correct', output.boundaryCount, expected.expectedBoundaryCount),
    containsTerms('direct_task_content_correct', output.task, expected.expectedTaskTerms),
  ];
}

export function scoreCapabilityDecision(
  output: { selectedLane: string; candidateNames: string[] },
  expected: CapabilityDecisionBasicsExpected,
  registryNames: string[],
): DecisionContractScore[] {
  const selectedName = output.selectedLane.startsWith('capability.')
    ? output.selectedLane.slice('capability.'.length)
    : null;
  const candidatesMatch = output.candidateNames.length === expected.expectedCandidateNames.length
    && output.candidateNames.every((name) => expected.expectedCandidateNames.includes(name));
  return [
    {
      key: 'candidate_recall_correct',
      score: candidatesMatch ? 1 : 0,
      comment: `expected=${expected.expectedCandidateNames.join(',')}; actual=${output.candidateNames.join(',')}`,
    },
    exact('capability_selection_correct', output.selectedLane, expected.expectedLane),
    {
      key: 'selected_capability_registered',
      score: selectedName === null || registryNames.includes(selectedName) ? 1 : 0,
      comment: selectedName ?? 'general',
    },
  ];
}

export function scoreOutcomeDecision(
  output: Record<string, unknown> & { outcome?: string },
  expected: OutcomeDecisionExpected,
): DecisionContractScore[] {
  const ownsForbiddenOutput = ['task', 'next_task', 'capability', 'capabilityId']
    .some((key) => output[key] !== undefined && output[key] !== null);
  return [
    exact('outcome_correct', output.outcome, expected.outcome),
    {
      key: 'outcome_ownership_correct',
      score: ownsForbiddenOutput ? 0 : 1,
      comment: ownsForbiddenOutput ? 'Outcome output contains task or capability fields.' : 'Verdict-only output.',
    },
  ];
}

export function scoreCapabilityPlanning(
  output: {
    result: string;
    nextTask?: string | null;
    capabilityIntent?: string | null;
    capabilityId?: string | null;
    planEffect: string;
    rubberStamp: boolean;
  },
  expected: CapabilityPlanningExpected,
): DecisionContractScore[] {
  return [
    exact('planner_result_correct', output.result, expected.result),
    exact('plan_effect_correct', output.planEffect, expected.planEffect),
    exact('rubber_stamp_correct', output.rubberStamp, expected.rubberStamp),
    exact('capability_intent_correct', output.capabilityIntent ?? null, expected.capabilityIntent ?? null),
    containsTerms('materialized_task_correct', output.nextTask, expected.nextTaskTerms),
    {
      key: 'planner_does_not_bind_capability_id',
      score: output.capabilityId ? 0 : 1,
      comment: output.capabilityId ?? 'No concrete capability id.',
    },
  ];
}
