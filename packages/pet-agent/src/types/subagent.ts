import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';

export type SubagentToolEvent =
  | {
      event: 'on_tool_start';
      toolCallId?: string;
      name: string;
      input: unknown;
    }
  | {
      event: 'on_tool_event';
      toolCallId?: string;
      name: string;
      data: unknown;
    }
  | {
      event: 'on_tool_end';
      toolCallId?: string;
      name: string;
      output: unknown;
    }
  | {
      event: 'on_tool_error';
      toolCallId?: string;
      name: string;
      error: unknown;
    };

export type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;

export type SubagentInput = {
  model: BaseChatModel;
  tools: StructuredTool[];
  instructions: string[];
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
