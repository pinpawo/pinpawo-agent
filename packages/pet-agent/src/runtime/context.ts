import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { optionalResponseSchema, type OptionalResponse } from './optionalResponse';
import { systemPromptSectionsSchema, type SystemPromptSection } from '../types/systemPrompt';
import { agentInvocationHintSchema, type AgentInvocationHint } from '../types/invocationHint';

/** Non-checkpointed, invocation-scoped context supplied by the Host. */
export type AgentRuntimeContext = {
  /** Effective execution directory supplied by the Host; never inferred by the runtime. */
  readonly workdir?: string | null;
  readonly systemPromptSections?: readonly SystemPromptSection[];
  readonly hint?: AgentInvocationHint;
  readonly optionalResponse?: OptionalResponse;
};

export const agentRuntimeContextSchema = z.object({
  workdir: z.string().refine(value => value.trim().length > 0, 'workdir must not be blank').nullable().optional(),
  systemPromptSections: systemPromptSectionsSchema.optional(),
  hint: agentInvocationHintSchema.optional(),
  optionalResponse: optionalResponseSchema.optional(),
}).passthrough();

/** Use the framework context channel; never fall back to graph config or globals. */
export function getAgentRuntimeContext(
  config?: LangGraphRunnableConfig,
): Required<Omit<AgentRuntimeContext, 'hint' | 'optionalResponse'>> & Pick<AgentRuntimeContext, 'hint' | 'optionalResponse'> {
  const context = agentRuntimeContextSchema.parse(config?.context ?? {});
  return Object.freeze({
    workdir: context.workdir ?? null,
    systemPromptSections: context.systemPromptSections ?? Object.freeze([]),
    ...(context.hint === undefined ? {} : { hint: context.hint }),
    ...(context.optionalResponse === undefined ? {} : { optionalResponse: context.optionalResponse }),
  });
}
