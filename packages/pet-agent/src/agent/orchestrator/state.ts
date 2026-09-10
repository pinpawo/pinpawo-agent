import { HumanMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { mergeDelegationDeliveries, type DelegationDelivery } from './delegation/delivery';
import type {
  CapabilityMessageLane,
  UserRequest,
} from './types';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { mergeCapabilityArtifactRefs } from './capabilityArtifacts';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import type {
  OrchestratorRuntimeFailure,
} from './runSupervisor/protocol';
import type { PauseTaskInterruptPayload } from './interrupt/pauseTaskInterrupt';
import type { RunSupervisorState } from './runSupervisor/state';
import type { CapabilityDisclosureState } from './runSupervisor/capabilityDisclosure';

export type SessionToolAuthorizationState = {
  generation: string;
  records: ToolAuthorizationRecord[];
};

export type OrchestratorTerminalErrorState = {
  readonly id: string;
  readonly node: string;
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly langChainErrorCode: string | null;
};

const orchestratorStateChannels = {
  runSupervisorState: Annotation<RunSupervisorState>({
    reducer: (_prev, next) => next,
    default: () => ({ goal: null, plan: [] }),
  }),
  runCapabilityDisclosure: Annotation<CapabilityDisclosureState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  sessionDelegationResults: Annotation<DelegationDelivery[]>({
    reducer: mergeDelegationDeliveries,
    default: () => [],
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // A pause resume can add user input within the same run, after iteration zero.
  // Consume this message identity in the next Supervisor decision only.
  runSupervisorUserMessageId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runUserRequest: Annotation<UserRequest | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  sessionCapabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: (prev, next) => mergeCapabilityArtifactRefs(prev, next),
    default: () => [],
  }),
  runIterationCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  runSupervisorReply: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runRuntimeFailure: Annotation<OrchestratorRuntimeFailure | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runTerminalError: Annotation<OrchestratorTerminalErrorState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  taskPauseInterrupt: Annotation<PauseTaskInterruptPayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sessionToolAuthorizations: Annotation<SessionToolAuthorizationState>({
    // Replace the complete generation-scoped snapshot atomically so grants
    // cannot outlive or become detached from the registry generation that owns them.
    reducer: (_prev, next) => ({
      generation: next.generation,
      records: mergeToolAuthorizations([], next.records),
    }),
    default: () => ({ generation: '', records: [] }),
  }),
};

export const ORCHESTRATOR_STATE_CHANNEL_NAMES = Object.keys(orchestratorStateChannels);

export const OrchestratorState = Annotation.Root(orchestratorStateChannels);

// Older snapshots may omit the newly introduced evidence channel. Graph hydration
// supplies its default; adapters also accept partial historical snapshots.
export type OrchestratorStateType = Omit<typeof OrchestratorState.State, 'sessionDelegationResults'> & {
  sessionDelegationResults?: DelegationDelivery[];
};

export type OrchestratorRunState = Pick<
  OrchestratorStateType,
  | 'runCapabilityDisclosure'
  | 'runSupervisorUserMessageId'
  | 'runUserRequest'
  | 'runIterationCount'
  | 'runSupervisorReply'
  | 'runRuntimeFailure'
  | 'runTerminalError'
  | 'taskPauseInterrupt'
  | 'runId'
  | 'traceId'
>;

export type BuildOrchestratorRunOptions = {
  /** Stable user-task identity. A fresh task receives a new value by default. */
  traceId?: string;
};

export function buildRunStateReset(
  options: BuildOrchestratorRunOptions = {},
): OrchestratorRunState {
  return {
    runCapabilityDisclosure: null,
    runSupervisorUserMessageId: null,
    runUserRequest: null,
    runIterationCount: 0,
    runSupervisorReply: null,
    runRuntimeFailure: null,
    runTerminalError: null,
    taskPauseInterrupt: null,
    runId: randomUUID().slice(0, 8),
    traceId: options.traceId ?? randomUUID(),
  };
}

export function buildOrchestratorRunInput(
  messages: BaseMessage[],
  options: BuildOrchestratorRunOptions = {},
) {
  const reset = buildRunStateReset(options);
  messages = messages.map((message) => message._getType() === 'human'
    ? setAgentMessageMetadata(new HumanMessage({ ...message, content: message.content }), { runId: reset.runId })
    : message);
  return {
    messages,
    ...reset,
  };
}

export type { CapabilityMessageLane };
