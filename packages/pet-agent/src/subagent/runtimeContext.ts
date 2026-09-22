import { z } from 'zod';
import { agentRuntimeContextSchema } from '../runtime/context';
import type { SubagentRuntimeContext } from '../types/subagent';

/** Mirrors DelegationScope; `satisfies` below keeps the two in step. */
const subagentExecutionScopeSchema = z.object({
  threadId: z.string().trim().min(1).nullable(),
  taskId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  delegationId: z.string().trim().min(1),
  workdir: z.string().refine(value => value.trim().length > 0, 'workdir must not be blank').nullable().optional(),
});

export const subagentRuntimeContextSchema = agentRuntimeContextSchema.extend({
  executionScope: subagentExecutionScopeSchema.optional(),
  toolkitName: z.string().optional(),
  toolkitRuntimeIdentities: z.record(z.string(), z.object({ clientId: z.string(), instanceId: z.string() })).optional(),
  toolkitRuntimes: z.record(z.string(), z.unknown()).optional(),
}).passthrough() satisfies z.ZodType<SubagentRuntimeContext>;
