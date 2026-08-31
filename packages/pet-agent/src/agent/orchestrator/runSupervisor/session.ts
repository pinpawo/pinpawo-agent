import type {
  CapabilityPlanTask,
  TaskActiveDelegation,
  UserRequest,
} from '../types';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { SupervisorCommand } from './protocol';

export type RunSupervisorSessionState = {
  readonly runId: string;
  readonly revision: number;
  readonly plan: readonly CapabilityPlanTask[];
  readonly capabilityDisclosure: CapabilityDisclosureState;
  readonly lastCommand: {
    readonly inputId: string;
    readonly registryDigest: string;
    readonly command: SupervisorCommand;
  } | null;
};

/**
 * Canonical resume seed written only when a root run ends with unfinished work.
 * It deliberately excludes Supervisor transcript, disclosure/search accounting,
 * revision, and command replay state.
 */
export type RunTaskContinuation = {
  readonly traceId: string;
  readonly userRequest: UserRequest;
  readonly activeDelegationId: string;
  readonly remainingPlan: readonly CapabilityPlanTask[];
};

export function snapshotRunTaskContinuation(params: {
  activeDelegation: TaskActiveDelegation | null;
  supervisorSession: RunSupervisorSessionState | null;
}): RunTaskContinuation | null {
  const { activeDelegation, supervisorSession } = params;
  if (!activeDelegation || !supervisorSession) return null;
  return {
    traceId: activeDelegation.traceId,
    userRequest: activeDelegation.userRequest,
    activeDelegationId: activeDelegation.id,
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
    lastCommand: null,
  };
}

export function updateRunSupervisorSession(params: {
  current: RunSupervisorSessionState;
  plan: readonly CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
  inputId: string;
  registryDigest: string;
  command: SupervisorCommand | null;
}): RunSupervisorSessionState {
  return {
    runId: params.current.runId,
    revision: params.current.revision + 1,
    plan: [...params.plan],
    capabilityDisclosure: params.capabilityDisclosure,
    lastCommand: params.command ? {
      inputId: params.inputId,
      registryDigest: params.registryDigest,
      command: params.command,
    } : null,
  };
}
