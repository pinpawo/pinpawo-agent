import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';

export type AgentActor = {
  petId: string;
  userId: string | null;
  name: string;
  personality: string | null;
  stage: string | null;
  species: string | null;
};

export type AgentModels = {
  /** Primary orchestration model; the local host keeps this variant non-thinking. */
  act: BaseChatModel;
  /** Compact model variant for structured routing and policy decisions. */
  decision?: BaseChatModel;
  /** Dedicated model variant for the final user-visible response. */
  answer?: BaseChatModel;
  observe?: BaseChatModel;
  /** Dedicated model variant for subagent execution. Falls back to `act` when omitted. */
  subagent?: BaseChatModel;
};

/**
 * Host-owned model request adaptation applied immediately before provider
 * invocation. This keeps transport concerns such as local attachment
 * rehydration and provider tool-choice limits outside model subclasses.
 */
export type AgentModelRequestPolicy = {
  prepareMessages?: (
    messages: readonly BaseMessage[],
  ) => readonly BaseMessage[] | Promise<readonly BaseMessage[]>;
  normalizeToolChoice?: (toolChoice: unknown) => unknown;
};

export type AgentExecution = {
  threadId?: string;
  dryRun?: boolean;
};
