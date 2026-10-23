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
import { createCapabilityExecutionMessage, DELEGATE_CAPABILITY_TOOL_NAME } from '../executionMessages';
import { createCapabilityCatalog } from './capabilityCatalog';

export const delegateCapabilitySchema = z.object({
  briefing: z.string().refine(text => text.trim().length > 0).describe('Execution instructions for the current plan item only. From the user\'s requirements and the deliveries returned so far, state the work to do, reusable conclusions and necessary constraints; do not copy earlier deliveries in full or expand into later tasks.'),
}).strict();

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
      state: state.runSupervisorState, runId: state.runId, allowedCapabilityNames: catalog.capabilityNames,
    }, args, runtime.toolCallId);
    const userRequest = acceptanceGoal(state.runSupervisorState);
    const compiledCapability = registry.capabilities.find(({ capability }) => capability.name === input.capability)!;
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: { id: input.delegationId, runId: state.runId, taskId: state.taskId,
        userRequest, task: input.task, briefing: input.briefing },
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
      result: { status: execution.status, delivery: execution.delivery, artifacts: execution.artifacts,
        ...(execution.reviewDecision ? { reviewDecision: execution.reviewDecision } : {}) },
      metadata: { runId: state.runId, taskId: state.taskId, delegationId: input.delegationId,
        sourceCapability: input.capability, runtimeGenerated: true,
        ...(execution.tokenUsage ? { capabilityTokenUsage: execution.tokenUsage } : {}) },
    });
    return new Command({ update: {
      messages: [result, ...(execution.reviewDecision ? [buildReviewStopMessage(execution.reviewDecision, {
        runId: state.runId, taskId: state.taskId,
      })] : [])],
      sessionCapabilityArtifacts: execution.artifacts,
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    } });
  }, {
    name: DELEGATE_CAPABILITY_TOOL_NAME, schema: delegateCapabilitySchema, verboseParsingErrors: true,
    description: 'Prepare a briefing for the current plan item, referring to relevant existing deliveries, and hand it to the Capability to execute. The runtime determines the task identity and the Capability; after it returns, you continue to judge.',
  });
}

export function buildCapabilityExecutionInput(
  context: Pick<SupervisorControlContext, 'state' | 'runId' | 'allowedCapabilityNames'>,
  args: DelegateCapabilityArgs,
  callId: string,
): CapabilityExecutionInput {
  const state = context.state;
  const next = currentSupervisorTask(state);
  if (!next) throw new SupervisorDecisionError('There is no planned task to execute.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new SupervisorDecisionError('Capability is no longer available.');
  return {
    planItemId: next.id,
    delegationId: identity('delegation', context.runId, callId),
    capability: next.capability,
    task: next.objective,
    briefing: args.briefing,
  };
}
