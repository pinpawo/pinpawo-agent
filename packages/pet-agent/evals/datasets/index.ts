import { capabilityPlanningBasicsDataset } from './capability-planning-basics.ts';
import { contextSynthesisBasicsDataset } from './context-synthesis-basics.ts';
import { delegationControlBasicsDataset } from './delegation-control-basics.ts';
import { interruptionRecoveryBasicsDataset } from './interruption-recovery-basics.ts';
import { multiTaskFlowBasicsDataset } from './multi-task-flow-basics.ts';
import { orchestratorLifecycleCompositionDataset } from './orchestrator-lifecycle-composition.ts';
import { orchestratorFlowMockSubagentDataset } from './orchestrator-flow-mock-subagent.ts';
import { orchestratorRouteDataset } from './orchestrator-route.ts';
import { permissionControlBasicsDataset } from './permission-control-basics.ts';
import { toolReviewRejectRuntimeDataset } from './tool-review-reject-runtime.ts';
import { resultSynthesisBasicsDataset } from './result-synthesis-basics.ts';

export const agentEvalDatasets = [
  resultSynthesisBasicsDataset,
  orchestratorRouteDataset,
  orchestratorFlowMockSubagentDataset,
  capabilityPlanningBasicsDataset,
  delegationControlBasicsDataset,
  interruptionRecoveryBasicsDataset,
  multiTaskFlowBasicsDataset,
  orchestratorLifecycleCompositionDataset,
  permissionControlBasicsDataset,
  contextSynthesisBasicsDataset,
  toolReviewRejectRuntimeDataset,
] as const;

export {
  resultSynthesisBasicsDataset,
  capabilityPlanningBasicsDataset,
  contextSynthesisBasicsDataset,
  delegationControlBasicsDataset,
  interruptionRecoveryBasicsDataset,
  multiTaskFlowBasicsDataset,
  orchestratorLifecycleCompositionDataset,
  orchestratorFlowMockSubagentDataset,
  orchestratorRouteDataset,
  permissionControlBasicsDataset,
  toolReviewRejectRuntimeDataset,
};
