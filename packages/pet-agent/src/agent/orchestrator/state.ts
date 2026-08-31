import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type {
  CapabilityMessageLane,
  RunNextDelegation,
  RunDelegationSummary,
  TaskActiveDelegation,
  ActiveDelegationTransition,
  UserRequest,
} from './types';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { mergeCapabilityArtifactRefs } from './capabilityArtifacts';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import type {
  OrchestratorRuntimeFailure,
  PlannerRouteOutcome,
  PlannerUserInputRequest,
} from './capabilityPlanner/protocol';
import type {
  PlannerSessionState,
  PlannerTaskContinuation,
} from './capabilityPlanner/session';
import { assertCanonicalAgentMessages } from '../messages';

export type SessionToolAuthorizationState = {
  generation: string;
  records: ToolAuthorizationRecord[];
};

export type OrchestratorTerminalErrorState = {
  readonly id: string;
  readonly node: string;
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly langChainErrorCode: string | null;
};

const orchestratorStateChannels = {
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  runNextDelegation: Annotation<RunNextDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runPlannerSession: Annotation<PlannerSessionState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runUserRequest: Annotation<UserRequest | null>({
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
  taskPlannerContinuation: Annotation<PlannerTaskContinuation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runDelegationSummaries: Annotation<RunDelegationSummary[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  runIterationCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  runLatestDelegationOutcome: Annotation<PlannerRouteOutcome | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runUserInputRequest: Annotation<PlannerUserInputRequest | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runRuntimeFailure: Annotation<OrchestratorRuntimeFailure | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runTerminalError: Annotation<OrchestratorTerminalErrorState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runActiveDelegationTransition: Annotation<ActiveDelegationTransition>({
    reducer: (_prev, next) => next,
    default: () => 'supersede_active',
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sessionToolAuthorizations: Annotation<SessionToolAuthorizationState>({
    // Replace the complete generation-scoped snapshot atomically so grants
    // cannot outlive or become detached from the registry generation that owns them.
    reducer: (_prev, next) => ({
      generation: next.generation,
      records: mergeToolAuthorizations([], next.records),
    }),
    default: () => ({ generation: '', records: [] }),
  }),
};

export const ORCHESTRATOR_STATE_CHANNEL_NAMES = Object.keys(orchestratorStateChannels);

export const OrchestratorState = Annotation.Root(orchestratorStateChannels);

export type OrchestratorStateType = typeof OrchestratorState.State;

export type OrchestratorRunState = Pick<
  OrchestratorStateType,
  | 'runNextDelegation'
  | 'runPlannerSession'
  | 'runUserRequest'
  | 'runDelegationSummaries'
  | 'runIterationCount'
  | 'runLatestDelegationOutcome'
  | 'runUserInputRequest'
  | 'runRuntimeFailure'
  | 'runTerminalError'
  | 'runActiveDelegationTransition'
  | 'runId'
  | 'traceId'
>;

export type BuildOrchestratorRunOptions = {
  activeDelegationTransition?: ActiveDelegationTransition;
  /** Stable user-task identity. A fresh task receives a new value by default. */
  traceId?: string;
};

export function buildRunStateReset(
  options: BuildOrchestratorRunOptions = {},
): OrchestratorRunState {
  return {
    runNextDelegation: null,
    runPlannerSession: null,
    runUserRequest: null,
    runDelegationSummaries: [],
    runIterationCount: 0,
    runLatestDelegationOutcome: null,
    runUserInputRequest: null,
    runRuntimeFailure: null,
    runTerminalError: null,
    runActiveDelegationTransition:
      options.activeDelegationTransition ?? 'supersede_active',
    runId: randomUUID().slice(0, 8),
    traceId: options.traceId ?? randomUUID(),
  };
}

export function buildOrchestratorRunInput(
  messages: BaseMessage[],
  options: BuildOrchestratorRunOptions = {},
) {
  assertCanonicalAgentMessages(messages);
  const reset = buildRunStateReset(options);
  if (options.activeDelegationTransition === 'resume_active') {
    // Preserve an interrupted prior run's session until prepare can extract
    // only its canonical plan into a fresh-run continuation seed.
    const { runPlannerSession: _priorRunPlannerSession, ...resumeReset } = reset;
    return {
      messages,
      ...resumeReset,
    };
  }
  return {
    messages,
    ...reset,
  };
}

/** @deprecated Use buildRunStateReset. Kept temporarily for external callers. */
export const buildTurnStateReset = buildRunStateReset;
/** @deprecated Use buildOrchestratorRunInput. Kept temporarily for external callers. */
export const buildOrchestratorTurnInput = buildOrchestratorRunInput;

export type { CapabilityMessageLane };
