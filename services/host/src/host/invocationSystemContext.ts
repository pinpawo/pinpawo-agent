import { getAgentRuntimeContext, type SystemPromptSection } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from '../agent/agentChannel';

/** Validate and snapshot provider results and persisted invocation context. */
export function snapshotInvocationSections(value: unknown): readonly SystemPromptSection[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid invocation prompt sections.');
  // The generic Agent schema validates structure, uniqueness and freezes a
  // snapshot. At this boundary also enforce resource limits and reject unknown
  // fields, which the generic schema intentionally strips for compatibility.
  if (value.some((section) => !section || typeof section !== 'object' || Array.isArray(section)
    || Object.keys(section).some((key) => !['id', 'owner', 'content'].includes(key))
    || (typeof section.content === 'string' && section.content.length > 500_000))) {
    throw new Error('Invalid invocation prompt sections.');
  }
  try {
    return getAgentRuntimeContext({ context: { systemPromptSections: value } }).systemPromptSections;
  } catch {
    throw new Error('Invalid invocation prompt sections.');
  }
}

/** Add immutable sections to this invocation without mutating the session setup. */
export function withInvocationSections(
  setup: AgentChannelSetup, sections?: readonly SystemPromptSection[],
): AgentChannelSetup {
  if (!sections?.length) return setup;
  return { ...setup, input: { ...setup.input, context: {
    ...setup.input.context,
    systemPromptSections: [...(setup.input.context?.systemPromptSections ?? []), ...sections],
  } } };
}
