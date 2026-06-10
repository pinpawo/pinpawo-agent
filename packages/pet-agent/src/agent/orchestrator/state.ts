import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type {
  CapabilitySearchState,
  MessageLane,
  PendingDelegation,
  TurnDelegation,
} from './types';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import type { PendingReviewSource, PendingReviewState, ToolReviewResolutionState } from './review/reviewSpec';

export const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  pendingDelegation: Annotation<PendingDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityResult: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilitySearchState: Annotation<CapabilitySearchState>({
    reducer: (_prev, next) => next,
    default: buildEmptyCapabilitySearchState,
  }),
  turnDelegations: Annotation<TurnDelegation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  iterationCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  turnId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  toolAuthorizations: Annotation<ToolAuthorizationRecord[]>({
    reducer: (prev, next) => mergeToolAuthorizations(prev, next),
    default: () => [],
  }),
  pendingReview: Annotation<PendingReviewState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  reviewResumeTarget: Annotation<PendingReviewSource | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  toolReviewResolutions: Annotation<ToolReviewResolutionState[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

export type OrchestratorStateType = typeof OrchestratorState.State;

export type OrchestratorTurnState = Pick<
  OrchestratorStateType,
  | 'pendingDelegation'
  | 'capabilityResult'
  | 'capabilitySearchState'
  | 'turnDelegations'
  | 'iterationCount'
  | 'turnId'
  | 'pendingReview'
  | 'reviewResumeTarget'
  | 'toolReviewResolutions'
>;

export function buildEmptyCapabilitySearchState(): CapabilitySearchState {
  return {
    query: null,
    attempted: false,
    candidates: [],
  };
}

export function buildTurnStateReset(): OrchestratorTurnState {
  return {
    pendingDelegation: null,
    capabilityResult: null,
    capabilitySearchState: buildEmptyCapabilitySearchState(),
    turnDelegations: [],
    iterationCount: 0,
    turnId: randomUUID().slice(0, 8),
    pendingReview: null,
    reviewResumeTarget: null,
    toolReviewResolutions: [],
  };
}

export function buildOrchestratorTurnInput(messages: BaseMessage[]) {
  return {
    messages,
    ...buildTurnStateReset(),
  };
}

export type { MessageLane };
