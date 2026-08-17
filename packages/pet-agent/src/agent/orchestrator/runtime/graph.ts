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
import { createAnswerNode } from './nodes/answer';
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
import { createAfterPlannerBoundaryIterationGuard } from './routes/afterPlannerBoundaryIterationGuard';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const subagentGenerationReserveTokens = readSubagentGenerationReserveTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const afterPlannerBoundaryIterationGuard =
    createAfterPlannerBoundaryIterationGuard({ orchestratorMaxIterations });
  const runCapabilityPlanner = createCapabilityPlannerNode(config);

  const entryAnswer = createEntryAnswerSubgraph(config);
  const resultAnswer = createAnswerNode(config);
  const capabilityNode = createCapabilityNode({
    config,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  });
  // Graph-visible anchor shared by resume and post-execution paths. Its
  // conditional edge owns deterministic guard evaluation and telemetry only;
  // it must not grow state updates or user-facing output.
  const plannerBoundaryIterationGuard = () => ({});

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('captureUserRequest', captureRunUserRequest)
    .addNode('entryAnswer', entryAnswer, {
      ends: ['capabilityPlanner'],
    })
    .addNode('capabilityPlanner', runCapabilityPlanner, {
      ends: ['answer', 'capability'],
    })
    .addNode('plannerBoundaryIterationGuard', plannerBoundaryIterationGuard)
    .addNode('answer', resultAnswer)
    .addNode('capability', capabilityNode)
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', afterPrepare, {
      answer: 'answer',
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
    .addConditionalEdges('plannerBoundaryIterationGuard', afterPlannerBoundaryIterationGuard, {
      answer: 'answer',
      capabilityPlanner: 'capabilityPlanner',
    })
    .addEdge('entryAnswer', END)
    .addEdge('answer', END)
    .addConditionalEdges('capability', afterCapability, {
      end: END,
      plannerBoundaryIterationGuard: 'plannerBoundaryIterationGuard',
    });

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
