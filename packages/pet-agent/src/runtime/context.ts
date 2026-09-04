import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { systemPromptSectionsSchema, type SystemPromptSection } from '../types/systemPrompt';

/** Non-checkpointed, invocation-scoped context supplied by the Host. */
export type AgentRuntimeContext = {
  readonly systemPromptSections?: readonly SystemPromptSection[];
};

export const agentRuntimeContextSchema = z.object({
  systemPromptSections: systemPromptSectionsSchema.optional(),
}).passthrough();

/** Use the framework context channel; never fall back to graph config or globals. */
export function getAgentRuntimeContext(
  config?: LangGraphRunnableConfig,
): Required<AgentRuntimeContext> {
  const context = agentRuntimeContextSchema.parse(config?.context ?? {});
  return Object.freeze({ systemPromptSections: context.systemPromptSections ?? Object.freeze([]) });
}
