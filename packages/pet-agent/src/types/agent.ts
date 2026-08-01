import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

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

export type AgentExecution = {
  threadId?: string;
  dryRun?: boolean;
};
