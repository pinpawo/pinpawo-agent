import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  RunDelegationSummary,
  UserRequest,
} from '../types';
import type {
  SupervisorAnnounceInput,
  SupervisorAnnounceTarget,
  SupervisorCommand,
  SupervisorDelegationInput,
} from './protocol';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { RunSupervisorSessionState } from './session';

export type RunSupervisorMode = 'entry' | 'boundary';

/**
 * Root-owned control state needed to materialize a Supervisor result. Canonical
 * messages cross the invocation seam separately and never become Supervisor state.
 */
export type RunSupervisorRuntimeState = Pick<
  {
    runId: string;
    traceId: string;
    runUserRequest: UserRequest;
    runDelegationSummaries: RunDelegationSummary[];
    runSupervisorSession: RunSupervisorSessionState | null;
  },
  | 'runId'
  | 'traceId'
  | 'runUserRequest'
  | 'runDelegationSummaries'
  | 'runSupervisorSession'
>;

export type RunSupervisorDispatch =
  {
    readonly mode: 'entry';
    readonly supervisorState: RunSupervisorRuntimeState;
    readonly messages: readonly BaseMessage[];
  };

type RunSupervisorInputBase = {
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: UserRequest;
  /** Canonical root messages. The Supervisor domain owns invocation projection. */
  readonly messages: readonly BaseMessage[];
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
  readonly capabilityDisclosure: CapabilityDisclosureState;
  /** The one typed run-scoped Supervisor state; never reconstructed from messages. */
  readonly supervisorSession: RunSupervisorSessionState;
};

export type RunSupervisorInput = RunSupervisorInputBase & (
  | {
      readonly mode: 'entry';
      readonly activeDelegation: null;
      readonly latestAnnounce: null;
      readonly announceAttempts: readonly SupervisorAnnounceInput[];
    }
  | {
      readonly mode: 'boundary';
      readonly activeDelegation: SupervisorDelegationInput;
      /** Boundary identity and stop reason. Evidence remains in canonical messages. */
      readonly latestAnnounce: SupervisorAnnounceTarget | null;
      /** Ordered unaccepted announces owned by the active delegation. */
      readonly announceAttempts: readonly SupervisorAnnounceInput[];
    }
);

export type RunSupervisorCommandResult = SupervisorCommand & {
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A Supervisor turn ended without a state-changing control command. */
export type RunSupervisorNoCommandResult = {
  readonly supervisorStatus: 'no_command';
  readonly reason: 'command_missing';
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type RunSupervisorResult =
  | RunSupervisorCommandResult
  | RunSupervisorNoCommandResult;

export function isRunSupervisorNoCommandResult(
  result: RunSupervisorResult,
): result is RunSupervisorNoCommandResult {
  return 'supervisorStatus' in result && result.supervisorStatus === 'no_command';
}

/**
 * Typed graph seam for the framework-internal Run Supervisor.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createRunSupervisorAgent(), whose raw transcript remains private to
 * invocation tracing and never crosses this seam into root messages.
 */
export interface RunSupervisorRunner {
  invoke(
    input: RunSupervisorInput,
    runnableConfig?: RunnableConfig,
  ): Promise<RunSupervisorResult>;
}
