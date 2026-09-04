import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';
import type { AnyAgentMiddleware } from 'langchain';
import type { CapabilityArtifactRef } from './artifact';
import type { SystemPromptSection } from './systemPrompt';
import type { AgentRuntimeContext } from '../runtime/context';
import type { ToolOperationMetadata } from './toolkit';

export type SubagentExecutionScope = {
  threadId: string | null;
  runId: string;
  delegationId: string;
  workdir?: string | null;
};

export type SubagentRuntimeContext = AgentRuntimeContext & {
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

export type SubagentPromptSection = SystemPromptSection;

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
  runnableConfig?: LangGraphRunnableConfig;
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
