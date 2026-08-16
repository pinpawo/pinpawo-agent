import { z } from 'zod';
import type { SubagentRuntimeContext } from '../types/subagent';

const subagentExecutionScopeSchema = z.object({
  threadId: z.string().trim().min(1).nullable(),
  runId: z.string().trim().min(1),
  delegationId: z.string().trim().min(1),
  workdir: z.string().trim().min(1).nullable().optional(),
});

export const subagentRuntimeContextSchema = z.object({
  executionScope: subagentExecutionScopeSchema.optional(),
}).passthrough() satisfies z.ZodType<SubagentRuntimeContext>;
