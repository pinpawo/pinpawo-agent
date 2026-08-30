import { StateGraph, START, END } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  OrchestratorState,
  type OrchestratorStateType,
} from '../state';
import type {
  OrchestratorConfig,
} from '../types';
import {
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
} from './constants';
import {
  readRunIterationLimit,
  readSubagentContextWindowTokens,
  readSubagentGenerationReserveTokens,
} from './config';
import { createFinalizeRunNode } from './nodes/finalizeRun';
import { createCapabilityNode } from './nodes/capability';
import { createCapabilityPlannerNode } from './nodes/capabilityPlanner';
import {
  captureRunUserRequest,
  createEntryAnswerSubgraph,
} from './nodes/entryAnswer';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterPrepare } from './routes/afterPrepare';
import { afterCapability } from './routes/afterCapability';
import { createPlannerBoundaryIterationGuardNode } from './nodes/plannerBoundaryIterationGuard';
import { createRunTerminationHandlers } from './runTermination';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const subagentGenerationReserveTokens = readSubagentGenerationReserveTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const plannerBoundaryIterationGuard = createPlannerBoundaryIterationGuardNode({
    orchestratorMaxIterations,
  });
  const runCapabilityPlanner = createCapabilityPlannerNode(config);
  const runTermination = createRunTerminationHandlers();

  const entryAnswer = createEntryAnswerSubgraph(config);
  const finalizeRun = createFinalizeRunNode(config);
  const capabilityNode = createCapabilityNode({
    config,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  });
  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('captureUserRequest', captureRunUserRequest)
    .addNode('entryAnswer', entryAnswer, {
      ends: ['capabilityPlanner'],
    })
    .addNode('capabilityPlanner', runCapabilityPlanner, {
      ends: ['finalizeRun', 'capability', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('plannerBoundaryIterationGuard', plannerBoundaryIterationGuard, {
      ends: ['finalizeRun', 'capabilityPlanner'],
    })
    .addNode('finalizeRun', finalizeRun, {
      ends: ['throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('capability', capabilityNode, {
      ends: ['throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('throwRunFailure', runTermination.throwRunFailure)
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', afterPrepare, {
      finalizeRun: 'finalizeRun',
      compactContext: 'compactContext',
    })
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // transcript/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      plannerBoundaryIterationGuard: 'plannerBoundaryIterationGuard',
      captureUserRequest: 'captureUserRequest',
      capability: 'capability',
    })
    .addEdge('captureUserRequest', 'entryAnswer')
    .addEdge('entryAnswer', END)
    .addEdge('finalizeRun', END)
    .addConditionalEdges('capability', afterCapability, {
      end: END,
      plannerBoundaryIterationGuard: 'plannerBoundaryIterationGuard',
    });

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
