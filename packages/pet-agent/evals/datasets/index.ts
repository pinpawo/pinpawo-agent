import { capabilitySearchBasicsDataset } from './capability-search-basics.ts';
import { contextSynthesisBasicsDataset } from './context-synthesis-basics.ts';
import { delegationControlBasicsDataset } from './delegation-control-basics.ts';
import { interruptionRecoveryBasicsDataset } from './interruption-recovery-basics.ts';
import { orchestratorRouteDataset } from './orchestrator-route.ts';
import { permissionControlBasicsDataset } from './permission-control-basics.ts';

export const agentEvalDatasets = [
  orchestratorRouteDataset,
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
  orchestratorRouteDataset,
  permissionControlBasicsDataset,
};
