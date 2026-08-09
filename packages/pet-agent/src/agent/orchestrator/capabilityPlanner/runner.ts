import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  PlannerAnswerDisposition,
  RunDelegationSummary,
  UserGoal,
} from '../types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

export const USER_GOAL_OBJECTIVE_MAX_CHARS = 2_000;
export const USER_GOAL_CONTEXT_MAX_CHARS = 4_000;
export const CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS = 16_000;

/**
 * The minimal run state a Planner node needs to materialize its result.
 * Keeping this separate from the full orchestrator state prevents an entry
 * dispatch from carrying the main-conversation transcript into the Planner.
 */
export type CapabilityPlannerRuntimeState = Pick<
  {
    runId: string;
    runUserGoal: UserGoal;
    runDelegationSummaries: RunDelegationSummary[];
    runCapabilityPlan: CapabilityPlanTask[];
  },
  'runId' | 'runUserGoal' | 'runDelegationSummaries' | 'runCapabilityPlan'
>;

export type CapabilityPlannerDispatch =
  | {
      readonly mode: 'entry';
      readonly plannerState: CapabilityPlannerRuntimeState;
    }
  | {
      readonly mode: 'boundary';
      readonly plannerState: CapabilityPlannerRuntimeState;
      readonly completedTask: string;
      /** Bounded accepted announce result for the task that just completed. */
      readonly completedTaskResult: string;
    };

type CapabilityPlannerInputBase = {
  readonly userGoal: UserGoal;
  readonly completedTask: string | null;
  /** Bounded accepted announce result for the latest completed delegation. */
  readonly completedTaskResult: string | null;
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & {
  readonly mode: CapabilityPlannerMode;
};

export type CapabilityPlannerResult =
  | {
      readonly tasks: readonly CapabilityPlanTask[];
    }
  | {
      readonly answer: PlannerAnswerDisposition;
    };

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
