import { capabilityPlanningBasicsDataset } from './capability-planning-basics.ts';
import { contextSynthesisBasicsDataset } from './context-synthesis-basics.ts';
import { delegationControlBasicsDataset } from './delegation-control-basics.ts';
import { entryDecisionBasicsDataset } from './entry-decision-basics.ts';
import { interruptionRecoveryBasicsDataset } from './interruption-recovery-basics.ts';
import { multiTaskFlowBasicsDataset } from './multi-task-flow-basics.ts';
import { orchestratorLifecycleCompositionDataset } from './orchestrator-lifecycle-composition.ts';
import { orchestratorFlowMockSubagentDataset } from './orchestrator-flow-mock-subagent.ts';
import { orchestratorRouteDataset } from './orchestrator-route.ts';
import { permissionControlBasicsDataset } from './permission-control-basics.ts';
import { toolReviewRejectRuntimeDataset } from './tool-review-reject-runtime.ts';

export const agentEvalDatasets = [
  answerBehaviorBasicsDataset,
  orchestratorRouteDataset,
  orchestratorFlowMockSubagentDataset,
  entryDecisionBasicsDataset,
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
  answerBehaviorBasicsDataset,
  capabilityPlanningBasicsDataset,
  contextSynthesisBasicsDataset,
  delegationControlBasicsDataset,
  entryDecisionBasicsDataset,
  interruptionRecoveryBasicsDataset,
  multiTaskFlowBasicsDataset,
  orchestratorLifecycleCompositionDataset,
  orchestratorFlowMockSubagentDataset,
  orchestratorRouteDataset,
  permissionControlBasicsDataset,
  toolReviewRejectRuntimeDataset,
};
import { answerBehaviorBasicsDataset } from './answer-behavior-basics.ts';
