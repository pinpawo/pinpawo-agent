import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod/v4';
import { ReducedValue, StateSchema } from '@langchain/langgraph';

/** Supervisor owns each planned task and its latest delegation execution. */
export const supervisorPlanItemSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(['pending', 'completed', 'superseded']),
  delegation: z.object({
    id: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    messages: z.array(z.custom<BaseMessage>()),
  }).strict().optional(),
}).strict();

/**
 * `runId` records which run established these facts, making the snapshot
 * self-describing: Supervisor state survives a run (that is what lets Entry
 * Answer offer `continue`), so without it nothing distinguishes the plan this
 * run just built from one left behind by an earlier request. Checkpoints
 * written before this field default to null, which reads as "not this run".
 */
export const runSupervisorStateSchema = z.object({
  runId: z.string().nullable().default(null),
  goal: z.string().nullable(),
  plan: z.array(supervisorPlanItemSchema),
}).strict();

export type SupervisorPlanItem = z.infer<typeof supervisorPlanItemSchema>;
export type RunSupervisorState = z.infer<typeof runSupervisorStateSchema>;

/** Model-facing plan facts exclude the execution transcripts owned by Supervisor. */
export function supervisorPlanSnapshot(state: RunSupervisorState) {
  return { ...state, plan: state.plan.map(({ delegation: _delegation, ...task }) => task) };
}

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
