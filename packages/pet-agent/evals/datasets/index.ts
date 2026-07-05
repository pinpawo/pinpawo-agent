import { capabilitySearchBasicsDataset } from './capability-search-basics.ts';
import { contextSynthesisBasicsDataset } from './context-synthesis-basics.ts';
import { delegationControlBasicsDataset } from './delegation-control-basics.ts';
import { interruptionRecoveryBasicsDataset } from './interruption-recovery-basics.ts';
import { orchestratorFlowMockSubagentDataset } from './orchestrator-flow-mock-subagent.ts';
import { orchestratorRouteDataset } from './orchestrator-route.ts';
import { permissionControlBasicsDataset } from './permission-control-basics.ts';

export const agentEvalDatasets = [
  orchestratorRouteDataset,
  orchestratorFlowMockSubagentDataset,
  capabilitySearchBasicsDataset,
  delegationControlBasicsDataset,
  interruptionRecoveryBasicsDataset,
  permissionControlBasicsDataset,
  contextSynthesisBasicsDataset,
] as const;

export {
  capabilitySearchBasicsDataset,
  contextSynthesisBasicsDataset,
  delegationControlBasicsDataset,
  interruptionRecoveryBasicsDataset,
  orchestratorFlowMockSubagentDataset,
  orchestratorRouteDataset,
  permissionControlBasicsDataset,
};
