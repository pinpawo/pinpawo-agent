import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from './toolkit';

export type SubagentToolOperationMetadata = ToolkitOperationMetadata & {
  source?: {
    provider: 'toolkit' | 'capability' | 'runtime';
    name: string;
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
  /**
   * 模型是否支持多模态(图片输入)。为 true 时,subagent 会把工具结果 artifact
   * 里携带的图片(`{ images: [...] }`)在下一次模型调用前作为一条 HumanMessage 喂给模型,
   * 让模型"看"到图片。默认 false(模型不支持图片,图片不喂入,只保留工具文本结果)。
   */
  multimodal?: boolean;
};

export type SubagentCompletionReason = 'natural' | 'limit_reached' | 'error';

export type SubagentResult = {
  messages: BaseMessage[];
  completionReason: SubagentCompletionReason;
};
