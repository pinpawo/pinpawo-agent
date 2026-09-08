import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  RunDelegationSummary,
  UserRequest,
} from '../types';
import type {
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
  /** Canonical main-view messages. The Supervisor domain owns provider projection. */
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
    }
  | {
      readonly mode: 'boundary';
      readonly activeDelegation: SupervisorDelegationInput;

    }
);

export type RunSupervisorCommandResult = SupervisorCommand & {
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A natural final reply preserves unfinished work without accepting it. */
export type RunSupervisorReplyResult = {
  readonly action?: never;
  readonly reply: string;
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type RunSupervisorResult = RunSupervisorCommandResult | RunSupervisorReplyResult;

export function isRunSupervisorReplyResult(result: RunSupervisorResult): result is RunSupervisorReplyResult {
  return !('action' in result);
}

/**
 * Typed graph seam for the framework-internal Run Supervisor.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createRunSupervisorAgent(), whose raw model/tool messages remain private to
 * invocation tracing and never cross this seam into root messages.
 */
export interface RunSupervisorRunner {
  invoke(
    input: RunSupervisorInput,
    runnableConfig?: RunnableConfig,
  ): Promise<RunSupervisorResult>;
}
