import type {
  CapabilityPlanTask,
  TaskActiveDelegation,
  UserRequest,
} from '../types';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { BaseMessage } from '@langchain/core/messages';

export type PendingDelegationCall = {
  readonly id: string;
  readonly name: 'delegate_capability';
  readonly delegationId: string;
};

/** Despite the historical name, this is run state, NOT Root session state. */
export type RunSupervisorSessionState = {
  readonly runId: string;
  readonly plan: readonly CapabilityPlanTask[];
  readonly capabilityDisclosure: CapabilityDisclosureState;
  /** Current run only. Never copied into session conversation or continuation. */
  readonly messages?: readonly BaseMessage[];
  readonly pendingCall?: PendingDelegationCall | null;
  readonly handledUserInputId?: string | null;
};

/**
 * Canonical resume seed written only when a root run ends with unfinished work.
 * It deliberately excludes Supervisor provider messages, tool-call history,
 * and command replay state.
 */
export type RunTaskContinuation = {
  readonly traceId: string;
  readonly userRequest: UserRequest;
  readonly activeDelegationId: string | null;
  readonly remainingPlan: readonly CapabilityPlanTask[];
};

export function snapshotRunTaskContinuation(params: {
  activeDelegation: TaskActiveDelegation | null;
  supervisorSession: RunSupervisorSessionState | null;
  traceId: string;
  userRequest: UserRequest | null;
}): RunTaskContinuation | null {
  const { activeDelegation, supervisorSession } = params;
  if (!supervisorSession || !params.userRequest
    || (!activeDelegation && supervisorSession.plan.length === 0)) return null;
  return {
    traceId: activeDelegation?.traceId ?? params.traceId,
    userRequest: activeDelegation?.userRequest ?? params.userRequest,
    activeDelegationId: activeDelegation?.id ?? null,
    remainingPlan: [...supervisorSession.plan],
  };
}

export function createRunSupervisorSession(params: {
  runId: string;
  plan?: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
}): RunSupervisorSessionState {
  return {
    runId: params.runId,
    plan: [...(params.plan ?? [])],
    capabilityDisclosure: params.capabilityDisclosure,
    messages: [],
    pendingCall: null,
    handledUserInputId: null,
  };
}

export function updateRunSupervisorSession(params: {
  current: RunSupervisorSessionState;
  plan: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
  messages?: readonly BaseMessage[];
  pendingCall?: PendingDelegationCall | null;
  handledUserInputId?: string | null;
}): RunSupervisorSessionState {
  return {
    runId: params.current.runId,
    plan: [...params.plan],
    capabilityDisclosure: params.capabilityDisclosure,
    messages: params.messages ?? params.current.messages ?? [],
    pendingCall: params.pendingCall === undefined ? params.current.pendingCall ?? null : params.pendingCall,
    handledUserInputId: params.handledUserInputId ?? params.current.handledUserInputId ?? null,
  };
}
