import { HumanMessage } from '@langchain/core/messages';
import { buildOrchestratorRunInput } from '../../../packages/pet-agent/src/agent/orchestrator/state';
import { createCapabilityExecutionMessage } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages';
import { runSupervisorStateSchema, type SupervisorPlanItem } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/state';
import { setAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { withDeliveryCalls } from '../../../packages/pet-agent/src/testing/capabilityDelivery';

/** Seed factual plans and native call/result pairs, never obsolete scheduling fields. */
export function buildRouteEvalInput(inputs: Record<string, unknown>) {
  const userMessage = String(inputs.user_message ?? '');
  const input = buildOrchestratorRunInput([new HumanMessage(userMessage)]);
  const plan: SupervisorPlanItem[] = [];
  const lane = typeof inputs.resume_progress_lane === 'string' ? inputs.resume_progress_lane.trim() : '';
  if (lane && (!lane.startsWith('capability:') || !lane.slice('capability:'.length))) {
    throw new Error('resume_progress_lane must identify a Capability.');
  }
  const previousRun = lane.length > 0;
  const evidenceRunId = previousRun ? 'fixture-previous-run' : input.runId;
  const evidenceTaskId = previousRun ? 'fixture-previous-task' : input.taskId;
  const goal = previousRun ? String(inputs.resume_original_user_message ?? userMessage) : userMessage;
  if (previousRun) input.messages.unshift(setAgentMessageMetadata(new HumanMessage(goal), {
    runId: evidenceRunId, taskId: evidenceTaskId,
  }));

  let evidenceCount = 0;
  function addEvidence(item: SupervisorPlanItem, text: string) {
    const id = `fixture-execution:${++evidenceCount}`;
    const scope = { runId: evidenceRunId, taskId: evidenceTaskId, delegationId: id,
      lane: `capability:${item.capability}` as const };
    input.messages.push(createCapabilityExecutionMessage({
      callId: `call:${id}`,
      execution: { planItemId: item.id, delegationId: id, capability: item.capability,
        task: item.objective, briefing: 'Execute the fixture plan item.' },
      result: { status: 'returned', artifacts: [], delivery: { id: `delivery:${id}`,
        task: item.objective, text, scope } },
      metadata: { runId: evidenceRunId, taskId: evidenceTaskId },
    }));
  }

  const completed = Array.isArray(inputs.completed_results) ? inputs.completed_results : [];
  const completedTasks = Array.isArray(inputs.completed_tasks) ? inputs.completed_tasks : [];
  completed.forEach((text, index) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const item: SupervisorPlanItem = { id: `fixture-completed:${index}`, capability: 'general',
      objective: typeof completedTasks[index] === 'string' && completedTasks[index].trim()
        ? completedTasks[index] : userMessage, status: 'completed' };
    plan.push(item);
    addEvidence(item, text);
  });

  const progress = (Array.isArray(inputs.progress_results) ? inputs.progress_results : [])
    .filter((text): text is string => typeof text === 'string' && !!text.trim());
  if (previousRun) {
    const item: SupervisorPlanItem = { id: 'fixture-retained', capability: lane.slice('capability:'.length),
      objective: String(inputs.resume_progress_task ?? goal), status: 'pending' };
    plan.push(item);
    const text = inputs.resume_progress_result;
    if (typeof text === 'string' && text.trim()) addEvidence(item, text);
  }
  if (progress.length) {
    const item: SupervisorPlanItem = { id: 'fixture-progress', capability: 'general',
      objective: userMessage, status: 'pending' };
    plan.push(item);
    for (const text of progress) addEvidence(item, text);
  }
  input.messages = withDeliveryCalls(input.messages);
  return { ...input, runSupervisorState: runSupervisorStateSchema.parse({
    runId: plan.length ? evidenceRunId : null, goal: plan.length ? goal : null, plan,
  }) };
}
