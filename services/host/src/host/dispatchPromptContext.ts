import type { SystemPromptSection } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from '../agent/agentChannel';

/** Copy admitted sections so a producer cannot mutate a queued or suspended run. */
export function copyDispatchPromptSections(value: unknown): readonly SystemPromptSection[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid dispatch prompt sections.');
  const seen = new Set<string>();
  return Object.freeze(value.map((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)
      || Object.keys(section).some((key) => !['id', 'owner', 'content'].includes(key))
      || typeof section.id !== 'string' || !section.id.trim()
      || typeof section.content !== 'string' || !section.content.trim()
      || section.content.length > 500_000
      || (section.owner !== undefined && typeof section.owner !== 'string')
      || seen.has(section.id.trim())) {
      throw new Error('Invalid dispatch prompt section.');
    }
    seen.add(section.id.trim());
    return Object.freeze({ id: section.id, ...(section.owner === undefined ? {} : { owner: section.owner }), content: section.content });
  }));
}

/** Add a dispatch's immutable sections to this invocation without mutating the session setup. */
export function withDispatchPromptSections(
  setup: AgentChannelSetup, sections?: readonly SystemPromptSection[],
): AgentChannelSetup {
  if (!sections?.length) return setup;
  return { ...setup, input: { ...setup.input, context: {
    ...setup.input.context,
    systemPromptSections: [...(setup.input.context?.systemPromptSections ?? []), ...sections],
  } } };
}
