import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { CapabilityExecutionInput } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorControlContext } from './controlContext';
import { currentSupervisorTask } from './state';
import type { OrchestratorStateType } from '../state';
import { createCapabilityExecutor, type CapabilityExecutionOptions } from '../capabilityExecution';
import { getInvokeOptions, getInvokeRegistry } from '../runtime/config';
import { createCapabilityExecutionMessage, DELEGATE_CAPABILITY_TOOL_NAME } from '../executionMessages';
import { createCapabilityCatalog } from './capabilityCatalog';

export const delegateCapabilitySchema = z.object({
  briefing: z.string().refine(text => text.trim().length > 0).describe('只为当前计划项准备执行说明。结合用户要求与已返回交付，说明要完成的工作、可复用结论和必要约束；不复制历史交付全文，不展开后续任务。'),
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
    // Every path that writes a plan also writes its goal, so a plan without one
    // is an invariant violation rather than something to fall back from.
    const userRequest = state.runSupervisorState.goal;
    if (!userRequest) throw new Error('Capability execution requires the plan goal.');
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
      result: { status: execution.status, delivery: execution.delivery, artifacts: execution.artifacts },
      metadata: { runId: state.runId, taskId: state.taskId, delegationId: input.delegationId,
        sourceCapability: input.capability, runtimeGenerated: true,
        ...(execution.tokenUsage ? { capabilityTokenUsage: execution.tokenUsage } : {}) },
    });
    return new Command({ update: {
      messages: [result],
      sessionCapabilityArtifacts: execution.artifacts,
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    } });
  }, {
    name: DELEGATE_CAPABILITY_TOOL_NAME, schema: delegateCapabilitySchema, verboseParsingErrors: true,
    description: '为当前计划项准备 briefing 并引用相关的已有交付，交给 Capability 执行。运行时确定任务身份与能力；返回后由你继续判断。',
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
