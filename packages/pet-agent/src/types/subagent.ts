import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ProviderUsageWatermarkGuardVerdict } from '../agent/providerUsageWatermarkGuard';
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

/**
 * Lets a subagent persist a capability artifact from inside the loop and have
 * the ref reach `state.sessionCapabilityArtifacts`. `recordCapabilityArtifact` is the
 * sink supplied by the orchestrator (it pushes into the shared artifacts array
 * that becomes `SubagentResult.artifacts`); the ids address a write. A
 * capability holds its own `CapabilityArtifactStore` by closure for the bytes;
 * this only carries what the subagent loop cannot otherwise see.
 *
 * This is the single artifact-sink shape shared by every layer that can persist
 * an artifact — the contextPolicy hook (here), the afterRun middleware
 * (`CapabilityMiddlewareContext`), and toolkit tools (`ToolkitContext`) all
 * expose the same `recordCapabilityArtifact` + addressing ids.
 */
export type CapabilityArtifactSink = {
  recordCapabilityArtifact?: (ref: CapabilityArtifactRef) => void | Promise<void>;
  threadId?: string | null;
  delegationId?: string;
  runId?: string;
};

export type ContextPolicyContext = {
  iterationCount: number;
  operations: Record<string, SubagentToolOperationMetadata>;
  latestProviderInputTokens?: number;
  contextWindowTokens?: number;
  providerUsageWatermark?: ProviderUsageWatermarkGuardVerdict;
  artifactSink?: CapabilityArtifactSink;
};

export type SubagentContextPolicy = {
  evictToolResults?: {
    keepRecent: number;
    defaultMode?: 'evict' | 'truncate';
    budgetTokens?: number;
    compressionThresholdRatio?: number;
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
  artifactSink?: CapabilityArtifactSink;
  onToolEvent?: SubagentToolEventHandler;
};

export type SubagentCompletionReason = 'natural' | 'limit_reached' | 'error';

export type SubagentResult = {
  messages: BaseMessage[];
  artifacts: CapabilityArtifactRef[];
  completionReason: SubagentCompletionReason;
};
