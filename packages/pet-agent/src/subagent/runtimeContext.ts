import { z } from 'zod';
import { agentRuntimeContextSchema } from '../runtime/context';
import type { SubagentRuntimeContext } from '../types/subagent';

const subagentExecutionScopeSchema = z.object({
  threadId: z.string().trim().min(1).nullable(),
  runId: z.string().trim().min(1),
  delegationId: z.string().trim().min(1),
  workdir: z.string().trim().min(1).nullable().optional(),
});

export const subagentRuntimeContextSchema = agentRuntimeContextSchema.extend({
  executionScope: subagentExecutionScopeSchema.optional(),
  toolkitRuntimes: z.record(z.string(), z.unknown()).optional(),
}).passthrough() satisfies z.ZodType<SubagentRuntimeContext>;
