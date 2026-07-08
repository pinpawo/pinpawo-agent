import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import {
  forcedCapabilitySeedGuard,
  ORCHESTRATOR_GUARD_POSITION,
  type ForcedCapabilitySeedDetails,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import { searchCapabilities } from '../../capabilitySearch';
import type { OrchestratorConfig } from '../../types';
import {
  getInvokeOptions,
} from '../config';
import { guardDecisionEmitter } from '../guards/decisionEvents';

export function createCapabilitySearchNode(params: {
  config: OrchestratorConfig;
}) {
  return function capabilitySearch(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const pendingTask = state.runPendingTask;
    if (!pendingTask) {
      return {};
    }

    const {
      capabilities,
      forcedCapabilityNames,
    } = getInvokeOptions(runnableConfig);
    const capabilityList = capabilities ?? [];

    const forcedSeedOutcome = evaluateGuard(forcedCapabilitySeedGuard, {
      state,
      config: { forcedCapabilityNames, capabilities: capabilityList },
      position: ORCHESTRATOR_GUARD_POSITION.CAPABILITY_SEARCH,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    if (forcedSeedOutcome.kind === 'derive') {
      const details = forcedSeedOutcome.details as ForcedCapabilitySeedDetails;
      return { runCapabilitySearchState: details.runCapabilitySearchState };
    }

    const query = (pendingTask.searchKeywords ?? pendingTask.task).trim();
    return {
      runCapabilitySearchState: {
        query: query || null,
        attempted: true,
        candidates: query ? searchCapabilities(query, capabilityList) : [],
      },
    };
  };
}
