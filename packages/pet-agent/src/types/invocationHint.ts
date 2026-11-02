import { z } from 'zod';

/** External preparation guidance for this invocation, separate from the user's goal. */
export type AgentInvocationHint = {
  readonly source: string;
  /** Host or Plugin collaboration guidance; it does not grant additional authority. */
  readonly instruction: string;
  /** An external routing model's suggestion, not a confirmed fact or authorization. */
  readonly focus?: string;
};

const nonBlankText = z.string().refine(value => Boolean(value.trim()), 'Invocation hint text must be non-empty');

/** Validate and snapshot without rewriting the provider's text or provenance. */
export const agentInvocationHintSchema = z.object({
  source: nonBlankText,
  instruction: nonBlankText,
  focus: nonBlankText.optional(),
}).strict().readonly();
