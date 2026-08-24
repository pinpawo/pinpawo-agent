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
  PlannerCommit,
  PlannerDelegationInput,
} from './protocol';
import type { CapabilityDisclosureState } from './capabilityDisclosure';

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
    runCapabilityPlan: CapabilityPlanTask[];
    runCapabilityDisclosure: CapabilityDisclosureState | null;
  },
  | 'runId'
  | 'traceId'
  | 'runUserRequest'
  | 'runDelegationSummaries'
  | 'runCapabilityPlan'
  | 'runCapabilityDisclosure'
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
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & (
  | {
      readonly mode: 'entry';
      readonly activeDelegation: null;
      readonly latestAnnounce: null;
    }
  | {
      readonly mode: 'boundary';
      readonly activeDelegation: PlannerDelegationInput;
      /** Boundary identity and stop reason. Evidence remains in canonical messages. */
      readonly latestAnnounce: PlannerAnnounceInput | null;
    }
);

export type CapabilityPlannerCommitResult = PlannerCommit & {
  /** Planner-lane updates to merge into the root orchestrator messages. */
  readonly messageUpdates?: readonly BaseMessage[];
  /** Production runners always return the updated trace-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

/** A Planner turn ended without a valid terminal control action. */
export type CapabilityPlannerIncompleteResult = {
  readonly plannerStatus: 'incomplete';
  readonly reason: 'terminal_commit_missing';
  /** Authentic Planner-lane updates to merge into the root orchestrator messages. */
  readonly messageUpdates?: readonly BaseMessage[];
  /** Production runners always return the updated trace-scoped disclosure. */
  readonly capabilityDisclosure?: CapabilityDisclosureState;
};

export type CapabilityPlannerResult =
  | CapabilityPlannerCommitResult
  | CapabilityPlannerIncompleteResult;

export function isCapabilityPlannerIncompleteResult(
  result: CapabilityPlannerResult,
): result is CapabilityPlannerIncompleteResult {
  return 'plannerStatus' in result && result.plannerStatus === 'incomplete';
}

/**
 * Typed graph seam for the framework-internal Capability Planner.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createCapabilityPlannerAgent(), whose transcript and document
 * observations are returned as isolated root Planner-lane updates.
 */
export interface CapabilityPlannerRunner {
  invoke(
    input: CapabilityPlannerInput,
    runnableConfig?: RunnableConfig,
  ): Promise<CapabilityPlannerResult>;
}
