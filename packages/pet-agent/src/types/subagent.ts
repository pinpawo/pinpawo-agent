import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { CapabilityArtifactRef } from './artifact';
import type { ToolOperationMetadata } from './toolkit';

export type SubagentToolOperationMetadata = ToolOperationMetadata & {
  source?: {
    provider: 'toolkit' | 'toolset' | 'runtime';
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

export type SubagentToolEvent = SubagentToolLifecycleEvent | SubagentRuntimeEvent;

export type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;

export type ContextPolicyContext = {
  estimateMessagesTokens: (messages: BaseMessage[]) => number;
  iterationCount: number;
  operations: Record<string, SubagentToolOperationMetadata>;
  contextWindowTokens?: number;
};

export type SubagentContextPolicy = {
  evictToolResults?: {
    keepRecent: number;
    defaultMode?: 'evict' | 'truncate';
    budgetTokens?: number;
    minSizeChars?: number;
    keepFailures?: boolean;
    perTool?: Record<string, 'keep' | 'evict' | 'truncate'>;
  };
  rewrite?: (messages: BaseMessage[], ctx: ContextPolicyContext) => BaseMessage[];
  rewriteAsync?: (messages: BaseMessage[], ctx: ContextPolicyContext) => BaseMessage[] | Promise<BaseMessage[]>;
};

export type SubagentInput = {
  model: BaseChatModel;
  tools: StructuredTool[];
  instructions: string[];
  operations?: Record<string, SubagentToolOperationMetadata>;
  messages: BaseMessage[];
  maxIterations?: number;
  contextWindowTokens?: number;
  contextPolicy?: SubagentContextPolicy;
  checkpoint?: BaseCheckpointSaver;
  runnableConfig?: RunnableConfig;
  signal?: AbortSignal;
  artifacts?: CapabilityArtifactRef[];
  onToolEvent?: SubagentToolEventHandler;
};

export type SubagentCompletionReason = 'natural' | 'limit_reached' | 'error';

export type SubagentResult = {
  messages: BaseMessage[];
  artifacts: CapabilityArtifactRef[];
  completionReason: SubagentCompletionReason;
};
