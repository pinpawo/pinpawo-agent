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
import { createRunSupervisorNode } from './nodes/runSupervisor';
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
import { createAfterSupervisorBoundaryIterationGuard } from './routes/afterSupervisorBoundaryIterationGuard';
import { createRunTerminationHandlers } from './runTermination';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const subagentGenerationReserveTokens = readSubagentGenerationReserveTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const afterSupervisorBoundaryIterationGuard =
    createAfterSupervisorBoundaryIterationGuard({ orchestratorMaxIterations });
  const runSupervisor = createRunSupervisorNode(config);
  const runTermination = createRunTerminationHandlers();

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
  const supervisorBoundaryIterationGuard = () => ({});

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('captureUserRequest', captureRunUserRequest)
    .addNode('entryAnswer', entryAnswer, {
      ends: ['runSupervisor'],
    })
    .addNode('runSupervisor', runSupervisor, {
      ends: ['answer', 'capability', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('supervisorBoundaryIterationGuard', supervisorBoundaryIterationGuard)
    .addNode('answer', resultAnswer, {
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
      answer: 'answer',
      compactContext: 'compactContext',
    })
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // message/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      supervisorBoundaryIterationGuard: 'supervisorBoundaryIterationGuard',
      captureUserRequest: 'captureUserRequest',
      capability: 'capability',
    })
    .addEdge('captureUserRequest', 'entryAnswer')
    .addConditionalEdges('supervisorBoundaryIterationGuard', afterSupervisorBoundaryIterationGuard, {
      answer: 'answer',
      runSupervisor: 'runSupervisor',
    })
    .addEdge('entryAnswer', END)
    .addEdge('answer', END)
    .addConditionalEdges('capability', afterCapability, {
      end: END,
      supervisorBoundaryIterationGuard: 'supervisorBoundaryIterationGuard',
    });

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
