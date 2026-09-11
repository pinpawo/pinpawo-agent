import type { BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageDelegationId,
  getAgentMessageLane,
  getAgentMessageRunId,
} from '../src/agent/messages/index.ts';
import type { OrchestratorStateType } from '../src/agent/orchestrator/state.ts';
import { currentSupervisorTask } from '../src/agent/orchestrator/runSupervisor/state';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type {
  LifecycleCompositionExpected,
} from './datasets/orchestrator-lifecycle-composition.ts';

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
    | 'runSupervisorState'
    | 'runIterationCount'
  >;
  assistantMessageCount: number;
  executorCallCount: number;
  expectedExecutorCallRange: {
    min: number;
    max: number;
  };
  expectedCheckpointState: LifecycleCompositionExpected['checkpointState'];
}): LifecycleCompositionInvariant[] {
  const state = params.finalState;
  const retainedLaneMessages = state.messages.filter(
    (message: BaseMessage) => getAgentMessageLane(message) !== null,
  );
  const current = currentSupervisorTask(state.runSupervisorState);
  const cleanCheckpoint = current === null;
  const resumableCheckpoint = current !== null;
  const checkpointStateMatches = params.expectedCheckpointState === 'clean' ? cleanCheckpoint : resumableCheckpoint;
  // Older private scopes may remain physically stored. Isolation means every
  // private record retains its owner, not that old execution history is erased.
  const laneIsolationMatches = retainedLaneMessages.every((message) =>
    getAgentMessageLane(message) === 'supervisor' ? Boolean(getAgentMessageRunId(message))
      : Boolean(getAgentMessageRunId(message) && getAgentMessageDelegationId(message)));
  const executorCallCountWithinExpectedRange = params.executorCallCount
    >= params.expectedExecutorCallRange.min
    && params.executorCallCount <= params.expectedExecutorCallRange.max;
  return [
    {
      id: 'checkpoint_state',
      passed: checkpointStateMatches,
      details: JSON.stringify({
        expected: params.expectedCheckpointState,
        runSupervisorState: state.runSupervisorState,
        runIterationCount: state.runIterationCount,
      }),
    },
    {
      id: 'lane_isolation',
      passed: laneIsolationMatches,
      details: [
        `expectedCheckpointState=${params.expectedCheckpointState}`,
        `remainingLaneMessages=${retainedLaneMessages.length.toString()}`,
      ].join(' '),
    },
    {
      id: 'assistant_output_present',
      passed: params.assistantMessageCount > 0,
      details: `assistantMessages=${params.assistantMessageCount.toString()}`,
    },
    {
      id: 'executor_call_count',
      passed: executorCallCountWithinExpectedRange,
      details: [
        `executorCalls=${params.executorCallCount.toString()}`,
        `expectedMin=${params.expectedExecutorCallRange.min.toString()}`,
        `expectedMax=${params.expectedExecutorCallRange.max.toString()}`,
      ].join(' '),
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
