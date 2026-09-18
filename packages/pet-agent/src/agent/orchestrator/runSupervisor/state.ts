import { z } from 'zod/v4';
import { ReducedValue, StateSchema } from '@langchain/langgraph';

/** Business facts only. Calls, private transcripts and run metadata live in Root. */
export const supervisorPlanItemSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(['pending', 'completed', 'superseded']),
}).strict();

export const runSupervisorStateSchema = z.object({
  goal: z.string().nullable(),
  plan: z.array(supervisorPlanItemSchema),
}).strict();

export type SupervisorPlanItem = z.infer<typeof supervisorPlanItemSchema>;
export type RunSupervisorState = z.infer<typeof runSupervisorStateSchema>;

export function currentSupervisorTask(state: RunSupervisorState): SupervisorPlanItem | null {
  return state.plan.find((task) => task.status !== 'completed' && task.status !== 'superseded') ?? null;
}

export function updateSupervisorTask(
  state: RunSupervisorState,
  planItemId: string,
  status: SupervisorPlanItem['status'],
): RunSupervisorState {
  if (!state.plan.some((task) => task.id === planItemId)) {
    throw new Error('Supervisor task is not part of the plan.');
  }
  return { ...state, plan: state.plan.map((task) => task.id === planItemId ? { ...task, status } : task) };
}

/** Native agent state; parallel detail reads merge while decisions replace plan facts. */
export const supervisorAgentStateSchema = new StateSchema({
  runSupervisorState: new ReducedValue<RunSupervisorState, RunSupervisorState>(runSupervisorStateSchema as never, {
    inputSchema: runSupervisorStateSchema as never, reducer: (_, next) => next,
  }),
  reviewFeedback: new ReducedValue<string | null, string | null>(z.string().nullable().default(null) as never, {
    inputSchema: z.string().nullable() as never, reducer: (_, next) => next,
  }),
  disclosedCapabilityNames: new ReducedValue<string[], string[]>(z.array(z.string()).default([]) as never, {
    inputSchema: z.array(z.string()) as never, reducer: (current, next) => [...new Set([...current, ...next])],
  }),
});
export type SupervisorAgentState = {
  runSupervisorState: RunSupervisorState;
  reviewFeedback: string | null;
  disclosedCapabilityNames: string[];
};
