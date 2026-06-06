import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
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

export type SubagentToolEvent =
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

export type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;

export type SubagentInput = {
  model: BaseChatModel;
  tools: StructuredTool[];
  instructions: string[];
  operations?: Record<string, SubagentToolOperationMetadata>;
  messages: BaseMessage[];
  maxIterations?: number;
  signal?: AbortSignal;
  onToolEvent?: SubagentToolEventHandler;
};

export type SubagentCompletionReason = 'natural' | 'limit_reached' | 'error';

export type SubagentResult = {
  messages: BaseMessage[];
  completionReason: SubagentCompletionReason;
};
