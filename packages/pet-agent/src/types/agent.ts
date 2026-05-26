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
  act: BaseChatModel;
  observe?: BaseChatModel;
  /** Model variant for subagent execution. Falls back to `act` when omitted. */
  subagent?: BaseChatModel;
};

export type AgentExecution = {
  threadId?: string;
  dryRun?: boolean;
};
