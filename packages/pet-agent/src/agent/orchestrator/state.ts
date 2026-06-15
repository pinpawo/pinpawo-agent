import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type {
  CapabilitySearchState,
  MessageLane,
  PendingDelegation,
  TurnDelegation,
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
  pendingDelegation: Annotation<PendingDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityResult: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: (prev, next) => mergeCapabilityArtifactRefs(prev, next),
    default: () => [],
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
  };
}

export function buildOrchestratorTurnInput(messages: BaseMessage[]) {
  return {
    messages,
    ...buildTurnStateReset(),
  };
}

export type { MessageLane };
