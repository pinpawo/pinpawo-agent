import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityCatalog } from './capabilityCatalog';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { RunSupervisorState } from './state';

export type RunSupervisorMode = 'entry' | 'boundary';

export type RunSupervisorInput = {
  readonly mode: RunSupervisorMode;
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: string;
  readonly state: RunSupervisorState;
  readonly reviewFeedback?: string | null;
  /** Canonical records; the adapter selects main + this run's work lane. */
  readonly messages: readonly BaseMessage[];
  readonly catalog: CapabilityCatalog;
  readonly capabilityDisclosure: CapabilityDisclosureState;
};

export type RunSupervisorResult = {
  readonly runSupervisorState: RunSupervisorState;
  readonly reviewFeedback?: string | null;
  /** New work records and, when executing, the Supervisor's request handed to Root. */
  readonly messages: readonly BaseMessage[];
  readonly capabilityDisclosure: CapabilityDisclosureState;
};

export interface RunSupervisorRunner {
  invoke(input: RunSupervisorInput, runnableConfig?: RunnableConfig): Promise<RunSupervisorResult>;
}
