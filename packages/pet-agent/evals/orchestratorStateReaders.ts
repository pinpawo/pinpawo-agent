import type { OrchestratorStateType } from '../src/agent/orchestrator/state';
import { currentSupervisorTask, runSupervisorStateSchema } from '../src/agent/orchestrator/runSupervisor/state';
import { executionsForTask } from '../src/agent/orchestrator/executionMessages';
import { readCapabilityCall } from '../src/agent/orchestrator/runtime/delegationToolResult';

export type EvalOrchestratorStateSnapshot = Partial<OrchestratorStateType> & Record<string, unknown>;

export function readPendingDelegation(result: EvalOrchestratorStateSnapshot) {
  if (!result.messages || !result.runId || !result.traceId || !result.runSupervisorState) return null;
  try {
    const call = readCapabilityCall({ messages: result.messages, runId: result.runId, traceId: result.traceId,
      runSupervisorState: result.runSupervisorState });
    return { id: call.delegationId, lane: `capability:${call.capability}` as const, task: call.task,
      mode: call.mode, contextSummary: call.guidance };
  } catch { return null; }
}
export function routeModeFromResult(result: EvalOrchestratorStateSnapshot): 'answer' | 'capability' {
  return readPendingDelegation(result) ? 'capability' : 'answer';
}
export function activeCapabilityFromResult(result: EvalOrchestratorStateSnapshot): string | null {
  return readPendingDelegation(result)?.lane.slice('capability:'.length) ?? null;
}

/** Derived reporting views only; never checkpoint these as additional scheduling state. */
export function readRunDelegationSummaries(result: EvalOrchestratorStateSnapshot) {
  const parsed = runSupervisorStateSchema.safeParse(result.runSupervisorState);
  if (!parsed.success) return [];
  return parsed.data.plan.flatMap((task) => {
    const latest = executionsForTask({ messages: result.messages ?? [] }, task.id)
      .filter(({ metadata }) => metadata.runId === result.runId).at(-1);
    if (!latest) return [];
    const delivery = latest.result?.delivery;
    return [{ id: latest.execution.delegationId, lane: `capability:${task.capability}` as const, task: task.task,
      status: task.status === 'completed' ? 'completed' as const : task.status === 'superseded' ? 'superseded' as const
        : latest.result?.status === 'returned' ? 'progress' as const : 'pending' as const,
      resultPreview: delivery?.text ?? null }];
  });
}
export function readTaskActiveDelegation(result: EvalOrchestratorStateSnapshot) {
  const parsed = runSupervisorStateSchema.safeParse(result.runSupervisorState);
  const task = parsed.success ? currentSupervisorTask(parsed.data) : null;
  if (!task) return null;
  const latest = executionsForTask({ messages: result.messages ?? [] }, task.id).at(-1);
  if (!latest) return null;
  return { id: latest.execution.delegationId, lane: `capability:${task.capability}` as const,
    task: task.task, contextSummary: latest.execution.guidance, runId: String(latest.metadata.runId),
    traceId: String(latest.metadata.traceId), status: latest.result?.status === 'returned' ? 'awaiting_decision' : 'pending',
    resultPreview: null, userRequest: parsed.success ? parsed.data.goal ?? '' : '' };
}
export function hasObservedDelegation(result: EvalOrchestratorStateSnapshot): boolean {
  return readRunDelegationSummaries(result).some((task) => task.status === 'progress' || task.status === 'completed');
}
