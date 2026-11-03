import { agentInvocationHintSchema, getAgentRuntimeContext, type AgentInvocationHint, type SystemPromptSection } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from '../agent/agentChannel';

export type InvocationInputContext = Readonly<{
  systemPromptSections?: readonly SystemPromptSection[];
  hint?: AgentInvocationHint;
}>;
export type InvocationContextResult = readonly SystemPromptSection[] | InvocationInputContext | undefined;

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

/** Legacy section arrays retain their shape; object results stay invocation-local. */
export function snapshotInvocationContextResult(value: unknown): InvocationContextResult {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return snapshotInvocationSections(value);
  if (!value || typeof value !== 'object'
    || Object.keys(value).some(key => key !== 'systemPromptSections' && key !== 'hint')) {
    throw new Error('Invalid invocation context.');
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    ...(record.systemPromptSections !== undefined
      ? { systemPromptSections: snapshotInvocationSections(record.systemPromptSections) } : {}),
    ...(record.hint !== undefined ? { hint: agentInvocationHintSchema.parse(record.hint) } : {}),
  });
}

/** Normalize once before queue admission, retaining no references owned by producers. */
export function snapshotInvocationContext(value: unknown): InvocationInputContext {
  const snapshot = snapshotInvocationContextResult(value);
  return Object.freeze(Array.isArray(snapshot)
    ? { systemPromptSections: snapshot }
    : (snapshot ?? {}) as InvocationInputContext);
}

/** Add the original invocation context without changing history or the session setup. */
export function withInvocationContext(
  setup: AgentChannelSetup, invocation: InvocationInputContext,
): AgentChannelSetup {
  const { systemPromptSections: sections, hint } = invocation;
  const base = setup.input.context;
  if (!sections?.length && !hint && !Object.hasOwn(base ?? {}, 'hint')) return setup;
  // A fresh invocation or native review continuation owns its hint. Never
  // inherit one from an unrelated setup or the resume message's caller.
  const { hint: _previousHint, ...context } = base ?? {};
  return { ...setup, input: { ...setup.input, context: {
    ...context,
    ...(sections?.length ? { systemPromptSections: [...(base?.systemPromptSections ?? []), ...sections] } : {}),
    ...(hint ? { hint } : {}),
  } } };
}
