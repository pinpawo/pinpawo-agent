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

export const CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS = 16_000;

/**
 * The bounded run state a Planner node needs to understand recent context and
 * materialize its result. Delegation-lane transcripts stay outside this seam.
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
    readonly mainMessages: readonly BaseMessage[];
  };

type CapabilityPlannerInputBase = {
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: UserRequest;
  readonly mainMessages?: readonly BaseMessage[];
  readonly latestUserMessage: string | null;
  readonly activeDelegation: PlannerDelegationInput | null;
  /** Candidate execution evidence. Root has not accepted it as a handoff yet. */
  readonly latestAnnounce: PlannerAnnounceInput | null;
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & {
  readonly mode: CapabilityPlannerMode;
};

export type CapabilityPlannerResult = PlannerCommit;

/**
 * Typed graph seam for the framework-internal Capability Planner.
 *
 * Graph tests inject a scripted implementation of this interface. Production
 * uses createCapabilityPlannerAgent(), whose private transcript and document
 * observations never enter the parent orchestrator state.
 */
export interface CapabilityPlannerRunner {
  invoke(
    input: CapabilityPlannerInput,
    runnableConfig?: RunnableConfig,
  ): Promise<CapabilityPlannerResult>;
}
