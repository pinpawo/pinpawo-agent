import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type {
  CapabilityPlanTask,
  PlannerAnswerDisposition,
  RunDelegationSummary,
} from '../types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

/**
 * The task boundary prepared for one fresh Planner invocation. This is
 * deliberately not orchestrator state: graph dispatch owns its lifetime.
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

export type CapabilityPlannerDispatch = {
  readonly plannerState: CapabilityPlannerRuntimeState;
  readonly briefing: CapabilityPlannerBriefing;
};

type CapabilityPlannerInputBase = {
  /** Bounded request facts for this fresh Planner invocation. */
  readonly briefing: CapabilityPlannerBriefing;
  readonly completedTask: string | null;
  /** Structured result preview for the latest completed delegation, if any. */
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
