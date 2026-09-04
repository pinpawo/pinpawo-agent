import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { AnyAgentMiddleware } from 'langchain';
import type { CapabilityArtifactRef } from './artifact';
import type { ToolOperationMetadata } from './toolkit';

export type SubagentExecutionScope = {
  threadId: string | null;
  runId: string;
  delegationId: string;
  workdir?: string | null;
};

export type SubagentRuntimeContext = {
  executionScope?: SubagentExecutionScope;
  /** Opaque Toolkit Runtime ports, keyed by Toolkit name. */
  toolkitRuntimes?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
};

export type SubagentToolOperationMetadata = ToolOperationMetadata & {
  source?: {
    provider: 'toolkit' | 'runtime';
    name: string;
    toolName?: string;
  };
};

type SubagentToolEventMetadata = {
  operation?: SubagentToolOperationMetadata;
};

export type SubagentToolLifecycleEvent =
  | ({
      event: 'on_tool_start';
      toolCallId?: string;
      name: string;
      input: unknown;
    } & SubagentToolEventMetadata)
  | ({
      event: 'on_tool_event';
      toolCallId?: string;
      name: string;
      data: unknown;
    } & SubagentToolEventMetadata)
  | ({
      event: 'on_tool_end';
      toolCallId?: string;
      name: string;
      output: unknown;
    } & SubagentToolEventMetadata)
  | ({
      event: 'on_tool_error';
      toolCallId?: string;
      name: string;
      error: unknown;
    } & SubagentToolEventMetadata);

export type SubagentRuntimeEvent = {
  event: 'on_runtime_event';
  name: string;
  data: unknown;
};

export type SubagentPromptSection = {
  readonly id: string;
  readonly owner?: string;
  readonly content: string;
};

export type SubagentInputState = {
  promptSections: readonly SubagentPromptSection[];
  operations?: Record<string, SubagentToolOperationMetadata>;
  messages: BaseMessage[];
  maxIterations?: number;
  contextWindowTokens?: number;
  generationReserveTokens?: number;
  artifacts?: CapabilityArtifactRef[];
};

export type SubagentRunInput = SubagentInputState & {
  model: BaseChatModel;
  tools: StructuredTool[];
  middleware?: AnyAgentMiddleware[];
  /** Read-only invocation data exposed to tools as ToolRuntime.context. */
  runtimeContext?: SubagentRuntimeContext;
  runnableConfig?: RunnableConfig;
  signal?: AbortSignal;
};

export type SubagentCompletionReason =
  | 'natural'
  | 'limit_reached'
  | 'error';

export type SubagentResult = {
  messages: BaseMessage[];
  artifacts: CapabilityArtifactRef[];
  completionReason: SubagentCompletionReason;
  announceMessageId: string | null;
};
