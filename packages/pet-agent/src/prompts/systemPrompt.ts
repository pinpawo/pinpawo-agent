import type { SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { agentRuntimeContextSchema, type AgentRuntimeContext } from '../runtime/context';
import { systemPromptSectionsSchema, type SystemPromptSection } from '../types/systemPrompt';

export function validateSystemPromptSections(sections: readonly SystemPromptSection[]): void {
  systemPromptSectionsSchema.parse(sections);
}

/** One ordering contract: role prompt, Host sections, execution sections. */
export function resolveSystemPromptSections(
  context: AgentRuntimeContext,
  executionSections: readonly SystemPromptSection[] = [],
): readonly SystemPromptSection[] {
  return systemPromptSectionsSchema.parse([...(context.systemPromptSections ?? []), ...executionSections]);
}

/** Compose without flattening blocks, discarding metadata, or mutating the role message. */
export function composeSystemPrompt(
  role: SystemMessage,
  context: AgentRuntimeContext = {},
  executionSections: readonly SystemPromptSection[] = [],
): SystemMessage {
  const sections = resolveSystemPromptSections(context, executionSections);
  if (!sections.length) return role;
  const separator = role.content === '' ? '' : '\n\n';
  return role.concat(`${separator}${sections.map(({ content }) => content).join('\n\n')}`);
}

/** Shared implementation; only execution-local sections may be captured by its factory. */
export function createSystemPromptMiddleware(
  executionSections: readonly SystemPromptSection[] = [],
) {
  const sections = systemPromptSectionsSchema.parse(executionSections);
  return createMiddleware({
    name: 'SystemPrompt',
    contextSchema: agentRuntimeContextSchema,
    wrapModelCall: (request, handler) => handler({
      ...request,
      systemMessage: composeSystemPrompt(
        request.systemMessage,
        request.runtime.context,
        sections,
      ),
    }),
  });
}

export const systemPromptMiddleware = createSystemPromptMiddleware();
