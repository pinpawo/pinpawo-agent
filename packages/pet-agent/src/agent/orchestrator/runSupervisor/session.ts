import type {
  CapabilityPlanTask,
  TaskActiveDelegation,
  UserRequest,
} from '../types';
import type { CapabilityDisclosureState } from './capabilityDisclosure';

export type RunSupervisorSessionState = {
  readonly runId: string;
  readonly revision: number;
  readonly plan: readonly CapabilityPlanTask[];
  readonly capabilityDisclosure: CapabilityDisclosureState;
};

/**
 * Canonical resume seed written only when a root run ends with unfinished work.
 * It deliberately excludes Supervisor provider messages, tool-call history,
 * revision, and command replay state.
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
    revision: 0,
    plan: [...(params.plan ?? [])],
    capabilityDisclosure: params.capabilityDisclosure,
  };
}

export function updateRunSupervisorSession(params: {
  current: RunSupervisorSessionState;
  plan: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
}): RunSupervisorSessionState {
  return {
    runId: params.current.runId,
    revision: params.current.revision + 1,
    plan: [...params.plan],
    capabilityDisclosure: params.capabilityDisclosure,
  };
}
