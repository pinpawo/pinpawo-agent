import { capabilitySearchBasicsDataset } from './capability-search-basics.ts';
import { capabilityDecisionBasicsDataset } from './capability-decision-basics.ts';
import { capabilityPlanningBasicsDataset } from './capability-planning-basics.ts';
import { contextSynthesisBasicsDataset } from './context-synthesis-basics.ts';
import { delegationControlBasicsDataset } from './delegation-control-basics.ts';
import { entryDecisionBasicsDataset } from './entry-decision-basics.ts';
import { interruptionRecoveryBasicsDataset } from './interruption-recovery-basics.ts';
import { multiTaskFlowBasicsDataset } from './multi-task-flow-basics.ts';
import { orchestratorFlowMockSubagentDataset } from './orchestrator-flow-mock-subagent.ts';
import { orchestratorRouteDataset } from './orchestrator-route.ts';
import { outcomeDecisionBasicsDataset } from './outcome-decision-basics.ts';
import { permissionControlBasicsDataset } from './permission-control-basics.ts';
import { toolReviewRejectRuntimeDataset } from './tool-review-reject-runtime.ts';

export const agentEvalDatasets = [
  orchestratorRouteDataset,
  orchestratorFlowMockSubagentDataset,
  capabilitySearchBasicsDataset,
  entryDecisionBasicsDataset,
  capabilityDecisionBasicsDataset,
  outcomeDecisionBasicsDataset,
  capabilityPlanningBasicsDataset,
  delegationControlBasicsDataset,
  interruptionRecoveryBasicsDataset,
  multiTaskFlowBasicsDataset,
  permissionControlBasicsDataset,
  contextSynthesisBasicsDataset,
  toolReviewRejectRuntimeDataset,
] as const;

export {
  capabilitySearchBasicsDataset,
  capabilityDecisionBasicsDataset,
  capabilityPlanningBasicsDataset,
  contextSynthesisBasicsDataset,
  delegationControlBasicsDataset,
  entryDecisionBasicsDataset,
  interruptionRecoveryBasicsDataset,
  multiTaskFlowBasicsDataset,
  orchestratorFlowMockSubagentDataset,
  orchestratorRouteDataset,
  outcomeDecisionBasicsDataset,
  permissionControlBasicsDataset,
  toolReviewRejectRuntimeDataset,
};
