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
  },
  | 'runId'
  | 'traceId'
  | 'runUserRequest'
  | 'runDelegationSummaries'
  | 'runCapabilityPlan'
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
  readonly activeDelegation: PlannerDelegationInput | null;
  /** Boundary identity and stop reason. Evidence remains in canonical messages. */
  readonly latestAnnounce: PlannerAnnounceInput | null;
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & {
  readonly mode: CapabilityPlannerMode;
};

export type CapabilityPlannerResult = PlannerCommit & {
  /** Planner-lane updates to merge into the root orchestrator messages. */
  readonly messageUpdates?: readonly BaseMessage[];
};

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
