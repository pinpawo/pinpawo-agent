import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import type { CapabilityPlanTask } from '../types';

export type CapabilityPlannerMode = 'entry' | 'boundary';

type CapabilityPlannerInputBase = {
  /** Main-conversation transcript only; delegation lanes never enter this view. */
  readonly messages: readonly BaseMessage[];
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
