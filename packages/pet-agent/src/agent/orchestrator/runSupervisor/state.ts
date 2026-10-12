import { z } from 'zod/v4';
import { ReducedValue, StateSchema } from '@langchain/langgraph';

/** Supervisor owns goals and plan progress; execution results live in ToolMessages. */
export const supervisorPlanItemSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(['pending', 'completed', 'superseded']),
}).strict();

/**
 * `runId` records which run established these facts, making the snapshot
 * self-describing: Supervisor state survives a run (that is what lets Entry
 * Answer offer `continue`), so without it nothing distinguishes the plan this
 * run just built from one left behind by an earlier request. Null means no run
 * has established a plan yet.
 */
export const runSupervisorStateSchema = z.object({
  runId: z.string().nullable(),
  goal: z.string().nullable(),
  /** Supervisor's calibration of the goal from execution evidence; acceptance follows it. */
  adjustedGoal: z.string().optional(),
  plan: z.array(supervisorPlanItemSchema),
}).strict();

export type SupervisorPlanItem = z.infer<typeof supervisorPlanItemSchema>;
export type RunSupervisorState = z.infer<typeof runSupervisorStateSchema>;

export function currentSupervisorTask(state: RunSupervisorState): SupervisorPlanItem | null {
  return state.plan.find((task) => task.status !== 'completed' && task.status !== 'superseded') ?? null;
}

/**
 * Entry owns the goal: plan_request clears the snapshot so a new plan takes the
 * run's resolved request, and continue adopts the saved goal. Supervisor never
 * rewrites it; it records a calibrated adjustedGoal next to it instead.
 */
export function planGoal(context: { state: RunSupervisorState; userRequest: string }): string {
  return context.state.goal ?? context.userRequest;
}

/**
 * Every writer of a plan also writes or preserves its goal, so a planned task
 * without one is an invariant violation, not something to fall back from.
 */
export function requirePlanGoal(state: RunSupervisorState): string {
  if (!state.goal) throw new Error('Supervisor plan has no goal.');
  return state.goal;
}

/** The goal work is delegated and accepted against: the calibrated one when set. */
export function acceptanceGoal(state: RunSupervisorState): string {
  return state.adjustedGoal ?? requirePlanGoal(state);
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
  disclosedCapabilityNames: new ReducedValue<string[], string[]>(z.array(z.string()).default([]) as never, {
    inputSchema: z.array(z.string()) as never, reducer: (current, next) => [...new Set([...current, ...next])],
  }),
});
export type SupervisorAgentState = {
  runSupervisorState: RunSupervisorState;
  disclosedCapabilityNames: string[];
};
