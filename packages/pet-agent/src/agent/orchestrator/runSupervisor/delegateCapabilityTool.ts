import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { buildReviewStopMessage } from '../interrupt/reviewStop';
import { z } from 'zod';
import type { CapabilityExecutionInput } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorControlContext } from './controlContext';
import { acceptanceGoal, currentSupervisorTask } from './state';
import type { OrchestratorStateType } from '../state';
import { createCapabilityExecutor, type CapabilityExecutionOptions } from '../capabilityExecution';
import { getInvokeOptions, getInvokeRegistry } from '../runtime/config';
import { createCapabilityExecutionMessage, DELEGATE_CAPABILITY_TOOL_NAME, executionsForPlanItem } from '../executionMessages';
import { createCapabilityCatalog } from './capabilityCatalog';

export const delegateCapabilitySchema = z.object({
  briefing: z.string().refine(text => text.trim().length > 0).optional().describe('Full instructions for a first execution or a necessary correction of the current plan item. Omit when continuing unchanged work. Do not copy earlier deliveries in full or expand into later tasks.'),
  continue: z.literal(true).optional().describe('Continue the current task with its previous briefing unchanged and the existing deliveries. Omit briefing; the runtime supplies the continuation context.'),
}).strict().refine(args => (args.briefing !== undefined) !== (args.continue === true), {
  message: 'Provide exactly one of briefing or continue: true.',
});

export type DelegateCapabilityArgs = z.infer<typeof delegateCapabilitySchema>;

/** One executable tool definition, exposed by Supervisor and run by Root ToolNode. */
export function createDelegateCapabilityTool(options: CapabilityExecutionOptions) {
  const executeCapability = createCapabilityExecutor(options);
  return tool(async (args, runtime: ToolRuntime<OrchestratorStateType, Record<string, unknown>>) => {
    const state = runtime.state;
    const registry = getInvokeRegistry(runtime.config);
    const invokeOptions = getInvokeOptions(runtime.config);
    // The same catalog the Supervisor planned from decides what may execute.
    const catalog = createCapabilityCatalog({ registry, allowedCapabilityNames: invokeOptions.allowedCapabilityNames });
    // Plan checks first: delegating without an executable task is a correctable decision.
    const input = buildCapabilityExecutionInput({
      state: state.runSupervisorState, runId: state.runId, allowedCapabilityNames: catalog.capabilityNames, messages: state.messages,
    }, args, runtime.toolCallId);
    const userRequest = acceptanceGoal(state.runSupervisorState);
    const compiledCapability = registry.capabilities.find(({ capability }) => capability.name === input.capability)!;
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: { id: input.delegationId, runId: state.runId, taskId: state.taskId,
        userRequest, task: input.task, briefing: input.briefing,
        ...(input.continuation ? { continuation: input.continuation } : {}) },
      history: state.messages,
    }, {
      review: {
        authorizations: state.sessionToolAuthorizations.generation === registry.authorizationGeneration
          ? state.sessionToolAuthorizations.records : [],
        hostCapabilities: invokeOptions.reviewCapabilities, policy: invokeOptions.globalReviewPolicy,
      },
      runnableConfig: runtime.config,
    });
    // Native Command tool pattern: use the injected call ID for the actual result.
    const result = createCapabilityExecutionMessage({
      callId: runtime.toolCallId,
      execution: input,
      result: { status: execution.status, delivery: execution.delivery,
        ...(execution.deliverables.length ? { deliverables: execution.deliverables } : {}),
        ...(execution.reviewDecision ? { reviewDecision: execution.reviewDecision } : {}) },
      metadata: { runId: state.runId, taskId: state.taskId, delegationId: input.delegationId,
        sourceCapability: input.capability, runtimeGenerated: true,
        ...(execution.tokenUsage ? { capabilityTokenUsage: execution.tokenUsage } : {}) },
    });
    return new Command({ update: {
      messages: [result, ...(execution.reviewDecision ? [buildReviewStopMessage(execution.reviewDecision, {
        runId: state.runId, taskId: state.taskId,
      })] : [])],
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    } });
  }, {
    name: DELEGATE_CAPABILITY_TOOL_NAME, schema: delegateCapabilitySchema, verboseParsingErrors: true,
    description: 'Execute the current plan item. Supply briefing for a first execution or necessary correction; use continue: true to resume unchanged work from prior deliveries without rewriting its briefing. The runtime determines task identity and Capability; after it returns, you continue to judge.',
  });
}

export function buildCapabilityExecutionInput(
  context: Pick<SupervisorControlContext, 'state' | 'runId' | 'allowedCapabilityNames' | 'messages'>,
  args: DelegateCapabilityArgs,
  callId: string,
): CapabilityExecutionInput {
  const state = context.state;
  const next = currentSupervisorTask(state);
  if (!next) throw new SupervisorDecisionError('There is no planned task to execute.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new SupervisorDecisionError('Capability is no longer available.');
  if ((args.briefing !== undefined) === (args.continue === true)) {
    throw new SupervisorDecisionError('Provide exactly one of briefing or continue: true.');
  }
  const goal = acceptanceGoal(state);
  const execution = {
    planItemId: next.id,
    delegationId: identity('delegation', context.runId, callId),
    capability: next.capability,
    task: next.objective,
    goal,
  };
  if (args.continue) {
    const previous = executionsForPlanItem(context, next.id).filter(record => record.call.id !== callId).at(-1);
    if (!previous) throw new SupervisorDecisionError('Continuing requires a previous execution of the current task. Supply a briefing for its first execution.');
    if (previous.execution.capability !== next.capability || previous.execution.task !== next.objective
      || previous.execution.goal !== goal) {
      throw new SupervisorDecisionError('The task boundary changed since its previous execution. Supply a briefing for the updated task.');
    }
    return { ...execution, briefing: previous.execution.briefing,
      continuation: { delegationId: previous.execution.delegationId, deliveryId: previous.result.delivery?.id ?? null } };
  }
  if (!args.briefing?.trim()) throw new SupervisorDecisionError('The execution briefing must not be empty.');
  return { ...execution, briefing: args.briefing };
}
