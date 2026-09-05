import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/** Optional caller metadata for review and attribution, never a prompt persona. */
export type AgentActor = {
  userId: string | null;
  name: string;
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
