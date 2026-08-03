import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilityDocumentWorkspace } from './capabilityDocumentWorkspace';
import type { CapabilityPlanTask } from './types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

type CapabilityPlannerInputBase = {
  readonly messages: readonly BaseMessage[];
  readonly completedTask: string | null;
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
