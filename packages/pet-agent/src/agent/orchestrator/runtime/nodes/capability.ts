import type { RunnableConfig } from '@langchain/core/runnables';
import { capabilityResultMessage, readCapabilityCall } from '../delegationToolResult';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { createCapabilityExecutor } from '../../capabilityExecution';
import { getInvokeRegistry, getInvokeOptions } from '../config';

export function createCapabilityNode(params: {
  config: OrchestratorConfig;
  subagentContextWindowTokens: number | undefined;
  subagentGenerationReserveTokens: number | undefined;
}) {
  const { config } = params;
  const executeCapability = createCapabilityExecutor({
    models: config.models, modelInputModalities: config.modelInputModalities,
    capabilityArtifactStore: config.capabilityArtifactStore,
    toolkitRuntimeManager: config.toolkitRuntimeManager,
    subagentContextWindowTokens: params.subagentContextWindowTokens,
    subagentGenerationReserveTokens: params.subagentGenerationReserveTokens,
  });
  return async (state: OrchestratorStateType, runnableConfig?: RunnableConfig) => {
    const options = getInvokeOptions(runnableConfig);
    const registry = getInvokeRegistry(runnableConfig);
    const call = readCapabilityCall(state);
    const compiledCapability = registry.capabilities.find(({ capability }) => capability.name === call.capability);
    if (!compiledCapability || (options.allowedCapabilityNames && !options.allowedCapabilityNames.includes(call.capability))) {
      throw new Error('Capability call selects an unavailable capability.');
    }
    const userRequest = state.runSupervisorState.goal ?? state.runUserRequest;
    if (!userRequest) throw new Error('Capability execution requires a goal.');
    const delegation = { id: call.delegationId, runId: state.runId, traceId: state.traceId, userRequest, task: call.task };
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: call.mode === 'initial'
        ? { ...delegation, mode: 'initial', essentialContext: call.guidance }
        : { ...delegation, mode: 'continue', guidance: call.guidance },
      history: state.messages,
    }, {
      review: {
        authorizations: state.sessionToolAuthorizations.generation === registry.authorizationGeneration
          ? state.sessionToolAuthorizations.records : [],
        hostCapabilities: options.reviewCapabilities, policy: options.globalReviewPolicy,
      },
      runnableConfig,
    });
    return {
      messages: [...execution.privateMessages, capabilityResultMessage(state, call, {
        status: execution.status, delivery: execution.delivery, artifacts: execution.artifacts,
      })],
      sessionCapabilityArtifacts: execution.artifacts,
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    };
  };
}
