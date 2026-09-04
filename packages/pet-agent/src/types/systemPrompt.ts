import { z } from 'zod';

export type SystemPromptSection = {
  readonly id: string;
  readonly owner?: string;
  readonly content: string;
};

/** Shared by root context, direct model calls, and execution-local sections. */
export const systemPromptSectionsSchema = z.array(z.object({
  id: z.string().trim().min(1, 'System prompt section id must be non-empty'),
  owner: z.string().optional(),
  content: z.string().refine((value) => Boolean(value.trim()), 'System prompt section content must be non-empty'),
}).readonly()).superRefine((sections, context) => {
  const ids = new Set<string>();
  for (const [index, section] of sections.entries()) {
    if (ids.has(section.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `Duplicate system prompt section id: ${section.id}`,
      });
    }
    ids.add(section.id);
  }
}).readonly();
