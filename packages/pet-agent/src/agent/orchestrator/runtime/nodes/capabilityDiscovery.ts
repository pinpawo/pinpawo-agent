import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  capabilitySearchTool,
  readModelToolCalls,
} from '../../capabilitySearch';
import { evaluateGuard } from '../../../../guards';
import { readContextCompactionSummaries } from '../../contextCompaction';
import {
  forcedCapabilitySeedGuard,
  ORCHESTRATOR_GUARD_POSITION,
  type ForcedCapabilitySeedDetails,
} from '../../guardDefinitions';
import {
  readLatestHumanRequest,
  readRecentAnnounces,
  setPinpetMeta,
} from '../../messageLanes';
import {
  buildCapabilityDiscoveryInput,
  buildCapabilityDiscoveryRequestContext,
  buildCapabilityDiscoverySystemPrompt,
  buildRunDelegationContext,
} from '../../prompts';
import type { OrchestratorStateType } from '../../state';
import { resolveToolkitResources } from '../../subagentHandoff';
import type { OrchestratorConfig, ToolBindableChatModel } from '../../types';
import {
  validateUniqueCapabilityNames,
  validateUniqueToolkitNames,
  validateUniqueToolNames,
} from '../../validation';
import {
  generalLaneToolkits,
  getInvokeOptions,
  resolveActor,
} from '../config';
import {
  canSearchCapabilities,
  mainMessagesWithoutCompaction,
} from '../decisions/capabilityCandidates';
import { guardDecisionEmitter } from '../guards/decisionEvents';
export function createCapabilityDiscoveryNode(params: {
  config: OrchestratorConfig;
}) {
  return async function capabilityDiscovery(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const {
      capabilities,
      forcedCapabilityNames,
      toolkits,
      execution,
      workdir,
      runtimeEnvironment,
      reviewCapabilities,
      globalReviewPolicy,
    } = getInvokeOptions(runnableConfig);
    const actor = resolveActor(params.config, runnableConfig);
    const toolkitList = generalLaneToolkits(toolkits ?? []);
    validateUniqueToolkitNames(toolkitList);
    const generalToolkitResources = await resolveToolkitResources(toolkitList, undefined, {
      models: params.config.models,
      actor,
      messages: state.messages,
      execution,
      reviewCapabilities,
      globalReviewPolicy,
      toolAuthorizations: state.sessionToolAuthorizations,
    }, { includeInstructions: false });
    const generalTools = generalToolkitResources.tools;
    validateUniqueToolNames(generalTools);
    const capabilityList = capabilities ?? [];
    validateUniqueCapabilityNames(capabilityList);

    const forcedSeedOutcome = evaluateGuard(forcedCapabilitySeedGuard, {
      state,
      config: { forcedCapabilityNames, capabilities: capabilityList },
      position: ORCHESTRATOR_GUARD_POSITION.CAPABILITY_DISCOVERY,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    if (forcedSeedOutcome.kind === 'derive') {
      const details = forcedSeedOutcome.details as ForcedCapabilitySeedDetails;
      return { runCapabilitySearchState: details.runCapabilitySearchState };
    }

    const decisionBaseModel = params.config.models.act;
    const latestHumanRequest = readLatestHumanRequest(state.messages);
    const recentAnnounces = readRecentAnnounces(state.messages);
    const requestContext = buildCapabilityDiscoveryRequestContext({
      latestUserRequest: latestHumanRequest,
      recentMessages: mainMessagesWithoutCompaction(state.messages),
      recentAnnounces,
      contextSummaries: readContextCompactionSummaries(state.messages),
      capabilityArtifacts: state.sessionCapabilityArtifacts,
    });
    const searchAvailable = canSearchCapabilities(decisionBaseModel, state, capabilityList);

    if (!searchAvailable) {
      return {};
    }

    const discoveryModel = (decisionBaseModel as ToolBindableChatModel).bindTools!([capabilitySearchTool], { parallel_tool_calls: false });
    const response = await discoveryModel.invoke(
      [
        new SystemMessage(buildCapabilityDiscoverySystemPrompt({
          actor,
          runDelegationContext: buildRunDelegationContext(state.runDelegations),
          generalTools,
          workdir,
          runtimeEnvironment,
        })),
        new HumanMessage(buildCapabilityDiscoveryInput({
          latestUserRequest: latestHumanRequest,
          requestContext,
        })),
      ],
      runnableConfig,
    );

    const capabilitySearchCalls = readModelToolCalls(response).filter((call) => call.name === CAPABILITY_SEARCH_TOOL_NAME);
    if (capabilitySearchCalls.length === 0) {
      return {};
    }
    if (capabilitySearchCalls.length > 1) {
      throw new Error('capability discovery emitted multiple capability_search tool calls');
    }
    setPinpetMeta(response, { lane: 'orchestrator', runId: state.runId });

    return {
      messages: [response],
      runPendingDelegation: null,
    };
  };
}
