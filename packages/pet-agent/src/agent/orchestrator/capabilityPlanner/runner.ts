import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  PlannerAnswerDisposition,
  RunDelegationSummary,
} from '../types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

export const CAPABILITY_PLANNER_BRIEFING_OBJECTIVE_MAX_CHARS = 2_000;
export const CAPABILITY_PLANNER_BRIEFING_CONTEXT_MAX_CHARS = 4_000;
export const CAPABILITY_PLANNER_BOUNDARY_RESULT_MAX_CHARS = 16_000;

/**
 * The task boundary Entry prepares for one fresh Planner invocation. This is
 * deliberately not orchestrator state: graph dispatch owns its lifetime, and
 * it is an entry-only concept. At a task boundary the run's own facts
 * (completed task, its result, and the remaining plan) define the work, so a
 * briefing is neither carried forward nor reconstructed from the transcript.
 */
export type CapabilityPlannerBriefing = {
  readonly objective: string;
  readonly context: string | null;
};

/**
 * The minimal run state a Planner node needs to materialize its result.
 * Keeping this separate from the full orchestrator state prevents an entry
 * dispatch from carrying the main-conversation transcript into the Planner.
 */
export type CapabilityPlannerRuntimeState = Pick<
  {
    runId: string;
    runDelegationSummaries: RunDelegationSummary[];
    runCapabilityPlan: CapabilityPlanTask[];
  },
  'runId' | 'runDelegationSummaries' | 'runCapabilityPlan'
>;

export type CapabilityPlannerDispatch =
  | {
      readonly mode: 'entry';
      readonly plannerState: CapabilityPlannerRuntimeState;
      readonly briefing: CapabilityPlannerBriefing;
    }
  | {
      readonly mode: 'boundary';
      readonly plannerState: CapabilityPlannerRuntimeState;
      readonly completedTask: string;
      /** Bounded accepted announce result for the task that just completed. */
      readonly completedTaskResult: string;
    };

type CapabilityPlannerInputBase = {
  readonly completedTask: string | null;
  /** Bounded accepted announce result for the latest completed delegation. */
  readonly completedTaskResult: string | null;
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly workspace: CapabilityDocumentWorkspace;
};

/**
 * Planner input is discriminated by mode so the briefing cannot be faked at a
 * boundary: only an entry dispatch carries one.
 */
export type CapabilityPlannerInput = CapabilityPlannerInputBase & (
  | {
      readonly mode: 'entry';
      /** Bounded request facts Entry resolved for this fresh invocation. */
      readonly briefing: CapabilityPlannerBriefing;
    }
  | {
      readonly mode: 'boundary';
      readonly briefing?: undefined;
    }
);

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
