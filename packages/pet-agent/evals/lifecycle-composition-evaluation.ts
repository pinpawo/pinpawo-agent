import type { BaseMessage } from '@langchain/core/messages';
import {
  getMessageDelegationId,
  getMessageLane,
  getMessageTranscriptRunId,
} from '../src/agent/messages/index.ts';
import type { OrchestratorStateType } from '../src/agent/orchestrator/state.ts';
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
    | 'runNextDelegation'
    | 'runPlannerSession'
    | 'taskPlannerContinuation'
    | 'taskActiveDelegation'
    | 'runIterationCount'
    | 'runLatestDelegationOutcome'
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
    (message: BaseMessage) => getMessageLane(message) !== null,
  );
  const activeDelegation = state.taskActiveDelegation;
  const cleanCheckpoint = state.runNextDelegation === null
    && state.runPlannerSession === null
    && state.taskPlannerContinuation === null
    && activeDelegation === null
    && state.runIterationCount === 0
    && state.runLatestDelegationOutcome === null;
  const resumableCheckpoint = state.runNextDelegation === null
    && state.runPlannerSession === null
    && activeDelegation?.status === 'awaiting_decision'
    && state.taskPlannerContinuation?.activeDelegationId === activeDelegation.id
    && state.taskPlannerContinuation.traceId === activeDelegation.traceId
    && state.taskPlannerContinuation.userRequest === activeDelegation.userRequest
    && state.runIterationCount === 0
    && state.runLatestDelegationOutcome === null;
  const checkpointStateMatches = params.expectedCheckpointState === 'clean'
    ? cleanCheckpoint
    : resumableCheckpoint;
  const laneIsolationMatches = params.expectedCheckpointState === 'clean'
    ? retainedLaneMessages.length === 0
    : activeDelegation !== null
      && retainedLaneMessages.length > 0
      && retainedLaneMessages.every((message) =>
        getMessageLane(message) === activeDelegation.lane
        && getMessageTranscriptRunId(message) === activeDelegation.transcriptRunId
        && getMessageDelegationId(message) === activeDelegation.id);
  const executorCallCountWithinExpectedRange = params.executorCallCount
    >= params.expectedExecutorCallRange.min
    && params.executorCallCount <= params.expectedExecutorCallRange.max;
  return [
    {
      id: 'checkpoint_state',
      passed: checkpointStateMatches,
      details: JSON.stringify({
        expected: params.expectedCheckpointState,
        runNextDelegation: state.runNextDelegation,
        runPlannerSession: state.runPlannerSession,
        taskPlannerContinuation: state.taskPlannerContinuation,
        taskActiveDelegation: state.taskActiveDelegation,
        runIterationCount: state.runIterationCount,
        runLatestDelegationOutcome: state.runLatestDelegationOutcome,
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
