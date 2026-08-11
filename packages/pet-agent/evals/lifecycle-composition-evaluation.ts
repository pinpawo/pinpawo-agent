import type { BaseMessage } from '@langchain/core/messages';
import { getMessageLane } from '../src/agent/orchestrator/messageLanes.ts';
import type { OrchestratorStateType } from '../src/agent/orchestrator/state.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';

export type LifecycleCompositionInvariant = {
  id: string;
  passed: boolean;
  details: string;
};

export function resolveControlledExecutorResult(params: {
  turns: Array<{
    userMessage: string;
    executorResults: string[];
  }>;
  latestUserMessage: string | null;
  resultIndex: number;
}): {
  turnIndex: number;
  result: string | null;
} {
  const reverseIndex = [...params.turns].reverse().findIndex(
    ({ userMessage }) => userMessage === params.latestUserMessage,
  );
  const turnIndex = reverseIndex < 0
    ? -1
    : params.turns.length - reverseIndex - 1;
  return {
    turnIndex,
    result: turnIndex < 0
      ? null
      : params.turns[turnIndex]?.executorResults[params.resultIndex] ?? null,
  };
}

export function evaluateLifecycleCompositionInvariants(params: {
  finalState: Pick<
    OrchestratorStateType,
    | 'messages'
    | 'runNextDelegation'
    | 'runCapabilityPlan'
    | 'taskActiveDelegation'
    | 'runIterationCount'
    | 'runLatestDelegationOutcome'
  >;
  assistantMessageCount: number;
}): LifecycleCompositionInvariant[] {
  const state = params.finalState;
  const laneMessageCount = state.messages.filter(
    (message: BaseMessage) => getMessageLane(message) !== null,
  ).length;
  const terminalStateClean = state.runNextDelegation === null
    && state.runCapabilityPlan.length === 0
    && state.taskActiveDelegation === null
    && state.runIterationCount === 0
    && state.runLatestDelegationOutcome === null;
  return [
    {
      id: 'terminal_state_clean',
      passed: terminalStateClean,
      details: JSON.stringify({
        runNextDelegation: state.runNextDelegation,
        runCapabilityPlanLength: state.runCapabilityPlan.length,
        taskActiveDelegation: state.taskActiveDelegation,
        runIterationCount: state.runIterationCount,
        runLatestDelegationOutcome: state.runLatestDelegationOutcome,
      }),
    },
    {
      id: 'lane_isolation',
      passed: laneMessageCount === 0,
      details: `remainingLaneMessages=${laneMessageCount.toString()}`,
    },
    {
      id: 'assistant_output_present',
      passed: params.assistantMessageCount > 0,
      details: `assistantMessages=${params.assistantMessageCount.toString()}`,
    },
  ];
}

export function lifecycleCompositionGoalAchieved(
  scores: DecisionContractScore[],
  invariants: LifecycleCompositionInvariant[],
): boolean {
  return scores.every(({ score }) => score === 1)
    && invariants.every(({ passed }) => passed);
}
