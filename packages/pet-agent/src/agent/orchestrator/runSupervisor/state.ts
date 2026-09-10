import { z } from 'zod';

/** Business facts only. Calls, private transcripts and run metadata live in Root. */
export const supervisorPlanTaskSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  status: z.enum(['pending', 'executing', 'returned', 'completed', 'superseded']),
}).strict();

export const runSupervisorStateSchema = z.object({
  goal: z.string().nullable(),
  plan: z.array(supervisorPlanTaskSchema),
}).strict();

export type SupervisorPlanTask = z.infer<typeof supervisorPlanTaskSchema>;
export type RunSupervisorState = z.infer<typeof runSupervisorStateSchema>;

export function currentSupervisorTask(state: RunSupervisorState): SupervisorPlanTask | null {
  return state.plan.find((task) => task.status !== 'completed' && task.status !== 'superseded') ?? null;
}

export function updateSupervisorTask(
  state: RunSupervisorState,
  taskId: string,
  status: SupervisorPlanTask['status'],
): RunSupervisorState {
  if (!state.plan.some((task) => task.id === taskId)) {
    throw new Error('Supervisor task is not part of the plan.');
  }
  return { ...state, plan: state.plan.map((task) => task.id === taskId ? { ...task, status } : task) };
}
