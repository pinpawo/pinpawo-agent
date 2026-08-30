import type {
  CapabilityPlanTask,
  TaskActiveDelegation,
  UserRequest,
} from '../types';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { PlannerCommit } from './protocol';

export type PlannerSessionState = {
  readonly runId: string;
  readonly revision: number;
  readonly plan: readonly CapabilityPlanTask[];
  readonly capabilityDisclosure: CapabilityDisclosureState;
  readonly lastCommit: {
    readonly inputId: string;
    readonly registryDigest: string;
    readonly decision: PlannerCommit;
  } | null;
};

/**
 * Canonical resume seed written only when a root run ends with unfinished work.
 * It deliberately excludes Planner provider messages, disclosure/search accounting,
 * revision, and commit replay state.
 */
export type PlannerTaskContinuation = {
  readonly traceId: string;
  readonly userRequest: UserRequest;
  readonly activeDelegationId: string;
  readonly remainingPlan: readonly CapabilityPlanTask[];
};

export function snapshotPlannerTaskContinuation(params: {
  activeDelegation: TaskActiveDelegation | null;
  plannerSession: PlannerSessionState | null;
}): PlannerTaskContinuation | null {
  const { activeDelegation, plannerSession } = params;
  if (!activeDelegation || !plannerSession) return null;
  return {
    traceId: activeDelegation.traceId,
    userRequest: activeDelegation.userRequest,
    activeDelegationId: activeDelegation.id,
    remainingPlan: [...plannerSession.plan],
  };
}

export function createPlannerSession(params: {
  runId: string;
  plan?: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
}): PlannerSessionState {
  return {
    runId: params.runId,
    revision: 0,
    plan: [...(params.plan ?? [])],
    capabilityDisclosure: params.capabilityDisclosure,
    lastCommit: null,
  };
}

export function updatePlannerSession(params: {
  current: PlannerSessionState;
  plan: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
  inputId: string;
  registryDigest: string;
  decision: PlannerCommit | null;
}): PlannerSessionState {
  return {
    runId: params.current.runId,
    revision: params.current.revision + 1,
    plan: [...params.plan],
    capabilityDisclosure: params.capabilityDisclosure,
    lastCommit: params.decision ? {
      inputId: params.inputId,
      registryDigest: params.registryDigest,
      decision: params.decision,
    } : null,
  };
}
