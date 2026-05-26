import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { HumanReviewActionRequest, HumanReviewRequest } from '../agent/orchestrator/humanReview';
import type { AgentActor, AgentExecution, AgentModels } from './agent';
import type { CapabilityAvailabilityConfig } from './capability';

export type ToolkitContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
};

export type ToolkitResource<T> = T | ((ctx: ToolkitContext) => T | Promise<T>);

export type ToolkitToolReviewContext = ToolkitContext & {
  toolkitName: string;
  toolName: string;
  input: unknown;
};

export type ToolkitToolReviewPolicy = {
  request: (
    ctx: ToolkitToolReviewContext
  ) => HumanReviewRequest | null | Promise<HumanReviewRequest | null>;
  applyEdit?: (
    ctx: ToolkitToolReviewContext & { editedAction: HumanReviewActionRequest }
  ) => unknown | Promise<unknown>;
};

export type ToolkitPolicy = {
  toolReview?: Record<string, ToolkitToolReviewPolicy>;
};

export type AgentToolkit = {
  name: string;
  description: string;
  availability?: CapabilityAvailabilityConfig;
  tools?: ToolkitResource<StructuredTool[]>;
  instructions?: ToolkitResource<string[]>;
  policy?: ToolkitPolicy;
};
