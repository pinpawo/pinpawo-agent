import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type {
  RunCapabilitySearchState,
  RunFinalReplyRoute,
  MessageLane,
  RunPendingDelegation,
  RunDelegation,
  RunStopReason,
  TaskActiveDelegation,
} from './types';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { mergeCapabilityArtifactRefs } from './capabilityArtifacts';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';

export const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  runPendingDelegation: Annotation<RunPendingDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  // Transient routing signal set by the decision nodes so afterDecision can
  // distinguish an `answer` route that must run the answer node from an
  // inline fallback reply that already emitted its message and ends the turn.
  runPendingFinalReply: Annotation<RunFinalReplyRoute>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runStopReason: Annotation<RunStopReason | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  sessionCapabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: (prev, next) => mergeCapabilityArtifactRefs(prev, next),
    default: () => [],
  }),
  taskActiveDelegation: Annotation<TaskActiveDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runCapabilitySearchState: Annotation<RunCapabilitySearchState>({
    reducer: (_prev, next) => next,
    default: buildEmptyRunCapabilitySearchState,
  }),
  runDelegations: Annotation<RunDelegation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  runIterationCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  canHandoffActiveDelegation: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sessionToolAuthorizations: Annotation<ToolAuthorizationRecord[]>({
    reducer: (prev, next) => mergeToolAuthorizations(prev, next),
    default: () => [],
  }),
});

export type OrchestratorStateType = typeof OrchestratorState.State;

export type OrchestratorRunState = Pick<
  OrchestratorStateType,
  | 'runPendingDelegation'
  | 'runPendingFinalReply'
  | 'runStopReason'
  | 'runCapabilitySearchState'
  | 'runDelegations'
  | 'runIterationCount'
  | 'canHandoffActiveDelegation'
  | 'runId'
>;

export function buildEmptyRunCapabilitySearchState(): RunCapabilitySearchState {
  return {
    query: null,
    attempted: false,
    candidates: [],
  };
}

export function buildRunStateReset(): OrchestratorRunState {
  return {
    runPendingDelegation: null,
    runPendingFinalReply: null,
    runStopReason: null,
    runCapabilitySearchState: buildEmptyRunCapabilitySearchState(),
    runDelegations: [],
    runIterationCount: 0,
    canHandoffActiveDelegation: true,
    runId: randomUUID().slice(0, 8),
  };
}

export function buildOrchestratorRunInput(messages: BaseMessage[]) {
  return {
    messages,
    ...buildRunStateReset(),
  };
}

/** @deprecated Use buildRunStateReset. Kept temporarily for external callers. */
export const buildTurnStateReset = buildRunStateReset;
/** @deprecated Use buildOrchestratorRunInput. Kept temporarily for external callers. */
export const buildOrchestratorTurnInput = buildOrchestratorRunInput;

export type { MessageLane };
