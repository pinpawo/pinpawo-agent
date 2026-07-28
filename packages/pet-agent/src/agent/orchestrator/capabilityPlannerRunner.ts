import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityDocumentWorkspace } from './capabilityDocumentWorkspace';
import type { CapabilityPlanTask } from './types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

type CapabilityPlannerInputBase = {
  readonly userIntentContext: string;
  readonly completedTasks: ReadonlyArray<{
    readonly objective: string;
    readonly result: string | null;
  }>;
  readonly remainingPlan: readonly CapabilityPlanTask[];
  readonly latestHandoff: string | null;
  readonly workspace: CapabilityDocumentWorkspace;
};

export type CapabilityPlannerInput = CapabilityPlannerInputBase & {
  readonly mode: CapabilityPlannerMode;
};

export type CapabilityPlannerNextTask = {
  readonly objective: string;
  readonly capability_intent: string;
  readonly capability_name: string;
  readonly context_summary: string | null;
};

export type CapabilityPlannerResult =
  | {
      readonly result: 'next_task';
      readonly next_task: CapabilityPlannerNextTask;
      readonly remaining_plan: ReadonlyArray<{
        readonly objective: string;
        readonly capability_intent: string;
      }>;
    }
  | {
      readonly result: 'unavailable';
      readonly task: string;
      readonly reason: string;
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
