import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityCatalog } from './capabilityCatalog';
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
import type { DelegationDelivery } from '../delegation/delivery';

export type RunSupervisorMode = 'entry' | 'boundary';

/**
 * Root-owned control state needed to materialize a Supervisor result. Canonical
 * messages cross the invocation seam separately. Supervisor may seed a run-local
 * working view but never owns the canonical session conversation.
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
  readonly pendingDelegation?: SupervisorDelegationInput | null;
  readonly deliveries?: readonly DelegationDelivery[];
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: UserRequest;
  /** Canonical main-view messages. The Supervisor domain owns provider projection. */
  readonly messages: readonly BaseMessage[];
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly catalog: CapabilityCatalog;
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
  readonly messages?: readonly BaseMessage[];
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A natural final reply preserves unfinished work without accepting it. */
export type RunSupervisorReplyResult = {
  readonly messages?: readonly BaseMessage[];
  readonly action?: never;
  readonly reply: string;
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type RunSupervisorDelegationResult = {
  readonly action: 'delegate_capability';
  readonly toolCallId: string;
  readonly delegationId: string;
  readonly messages: readonly BaseMessage[];
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type RunSupervisorResult = RunSupervisorCommandResult | RunSupervisorReplyResult | RunSupervisorDelegationResult;

export function isRunSupervisorReplyResult(result: RunSupervisorResult): result is RunSupervisorReplyResult {
  return !('action' in result);
}

/**
 * Typed graph seam for the framework-internal Run Supervisor.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createRunSupervisorAgent(). Its working transcript crosses this seam into
 * run-scoped state, never into Root's user-facing session messages.
 */
export interface RunSupervisorRunner {
  invoke(
    input: RunSupervisorInput,
    runnableConfig?: RunnableConfig,
  ): Promise<RunSupervisorResult>;
}
