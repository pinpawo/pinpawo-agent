import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  RunDelegationSummary,
  UserRequest,
} from '../types';
import type {
  PlannerAnnounceInput,
  PlannerAnnounceTarget,
  PlannerCommit,
  PlannerDelegationInput,
} from './protocol';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { PlannerSessionState } from './session';

export type CapabilityPlannerMode = 'entry' | 'boundary';

/**
 * Root-owned control state needed to materialize a Planner result. Canonical
 * messages cross the invocation seam separately and never become Planner state.
 */
export type CapabilityPlannerRuntimeState = Pick<
  {
    runId: string;
    traceId: string;
    runUserRequest: UserRequest;
    runDelegationSummaries: RunDelegationSummary[];
    runPlannerSession: PlannerSessionState | null;
  },
  | 'runId'
  | 'traceId'
  | 'runUserRequest'
  | 'runDelegationSummaries'
  | 'runPlannerSession'
>;

export type CapabilityPlannerDispatch =
  {
    readonly mode: 'entry';
    readonly plannerState: CapabilityPlannerRuntimeState;
    readonly messages: readonly BaseMessage[];
  };

type CapabilityPlannerInputBase = {
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: UserRequest;
  /** Canonical root messages. The Planner domain owns invocation projection. */
  readonly messages: readonly BaseMessage[];
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
  readonly capabilityDisclosure: CapabilityDisclosureState;
  /** The one typed run-scoped Planner state; never reconstructed from messages. */
  readonly plannerSession: PlannerSessionState;
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & (
  | {
      readonly mode: 'entry';
      readonly activeDelegation: null;
      readonly latestAnnounce: null;
      readonly announceAttempts: readonly PlannerAnnounceInput[];
    }
  | {
      readonly mode: 'boundary';
      readonly activeDelegation: PlannerDelegationInput;
      /** Boundary identity and stop reason. Evidence remains in canonical messages. */
      readonly latestAnnounce: PlannerAnnounceTarget | null;
      /** Ordered unaccepted announces owned by the active delegation. */
      readonly announceAttempts: readonly PlannerAnnounceInput[];
    }
);

export type CapabilityPlannerCommitResult = PlannerCommit & {
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A Planner turn ended without a valid terminal control action. */
export type CapabilityPlannerIncompleteResult = {
  readonly plannerStatus: 'incomplete';
  readonly reason: 'terminal_commit_missing';
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A Planner protocol miss that still contains a complete user-facing reply. */
export type CapabilityPlannerDirectResponseResult = {
  readonly plannerStatus: 'direct_response';
  readonly response: string;
  /** Production runners always return the updated run-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type CapabilityPlannerResult =
  | CapabilityPlannerCommitResult
  | CapabilityPlannerDirectResponseResult
  | CapabilityPlannerIncompleteResult;

export function isCapabilityPlannerIncompleteResult(
  result: CapabilityPlannerResult,
): result is CapabilityPlannerIncompleteResult {
  return 'plannerStatus' in result && result.plannerStatus === 'incomplete';
}

export function isCapabilityPlannerDirectResponseResult(
  result: CapabilityPlannerResult,
): result is CapabilityPlannerDirectResponseResult {
  return 'plannerStatus' in result && result.plannerStatus === 'direct_response';
}

/**
 * Typed graph seam for the framework-internal Capability Planner.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createCapabilityPlannerAgent(), whose raw transcript remains private to
 * invocation tracing and never crosses this seam into root messages.
 */
export interface CapabilityPlannerRunner {
  invoke(
    input: CapabilityPlannerInput,
    runnableConfig?: RunnableConfig,
  ): Promise<CapabilityPlannerResult>;
}
