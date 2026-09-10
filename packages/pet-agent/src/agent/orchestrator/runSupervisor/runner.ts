import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CapabilityCatalog } from './capabilityCatalog';
import type { CapabilityDisclosureState } from './capabilityDisclosure';
import type { OrchestratorStateType } from '../state';
import type { RunSupervisorState } from './state';

export type RunSupervisorMode = 'entry' | 'boundary';

/** Invocation routing, not a persisted proposal or another owner of Root state. */
export type RunSupervisorDispatch = {
  mode: RunSupervisorMode;
  root: OrchestratorStateType;
};

export type RunSupervisorInput = {
  readonly mode: RunSupervisorMode;
  readonly inputId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly userRequest: string;
  readonly state: RunSupervisorState;
  /** Canonical records; the adapter selects main + this run's work lane. */
  readonly messages: readonly BaseMessage[];
  readonly catalog: CapabilityCatalog;
  readonly capabilityDisclosure: CapabilityDisclosureState;
};

export type RunSupervisorResult = {
  /** New work records and, when executing, the actual Root tool call. */
  readonly messages: readonly BaseMessage[];
  readonly reply?: string;
  readonly capabilityDisclosure: CapabilityDisclosureState;
};

export interface RunSupervisorRunner {
  invoke(input: RunSupervisorInput, runnableConfig?: RunnableConfig): Promise<RunSupervisorResult>;
}
