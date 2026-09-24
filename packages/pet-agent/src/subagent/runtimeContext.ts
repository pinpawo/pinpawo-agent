import { z } from 'zod';
import { agentRuntimeContextSchema } from '../runtime/context';
import type { SubagentRuntimeContext } from '../types/subagent';

/** Mirrors DelegationScope; `satisfies` below keeps the two in step. */
const subagentExecutionScopeSchema = z.object({
  threadId: z.string().trim().min(1).nullable(),
  taskId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  delegationId: z.string().trim().min(1),
  workdir: z.string().trim().min(1).nullable().optional(),
});

export const subagentRuntimeContextSchema = agentRuntimeContextSchema.extend({
  executionScope: subagentExecutionScopeSchema.optional(),
}).passthrough() satisfies z.ZodType<SubagentRuntimeContext>;
