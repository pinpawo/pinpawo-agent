import { HumanMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type {
  CapabilityMessageLane,
  UserRequest,
} from './types';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { mergeCapabilityArtifactRefs } from './capabilityArtifacts';
import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from '../../autoReview/reviewAuthorizations';
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
  runSupervisorReviewFeedback: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
  runSupervisorState: Annotation<RunSupervisorState>({
    reducer: (_prev, next) => next,
    default: () => ({ runId: null, goal: null, plan: [] }),
  }),
  runCapabilityDisclosure: Annotation<CapabilityDisclosureState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
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
  runTerminalError: Annotation<OrchestratorTerminalErrorState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  taskId: Annotation<string>({
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

export type OrchestratorStateType = typeof OrchestratorState.State;

export type OrchestratorRunState = Pick<
  OrchestratorStateType,
  | 'runSupervisorReviewFeedback'
  | 'runCapabilityDisclosure'
  | 'runSupervisorUserMessageId'
  | 'runUserRequest'
  | 'runIterationCount'
  | 'runTerminalError'
  | 'runId'
  | 'taskId'
>;

export type BuildOrchestratorRunOptions = {
  /** Stable user-task identity. A fresh task receives a new value by default. */
  taskId?: string;
};

export function buildRunStateReset(
  options: BuildOrchestratorRunOptions = {},
): OrchestratorRunState {
  return {
    runCapabilityDisclosure: null,
    runSupervisorReviewFeedback: null,
    runSupervisorUserMessageId: null,
    runUserRequest: null,
    runIterationCount: 0,
    runTerminalError: null,
    runId: randomUUID().slice(0, 8),
    taskId: options.taskId ?? randomUUID(),
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
