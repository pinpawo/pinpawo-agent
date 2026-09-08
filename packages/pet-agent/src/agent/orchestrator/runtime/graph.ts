import { StateGraph, START, END } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { agentRuntimeContextSchema } from '../../../runtime/context';
import {
  OrchestratorState,
  type OrchestratorStateType,
} from '../state';
import type {
  OrchestratorConfig,
} from '../types';
import {
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
import { afterCapability } from './routes/afterCapability';
import { afterPauseGate, pauseGate } from './nodes/pauseGate';
import { createAfterSupervisorBoundaryIterationGuard } from './routes/afterSupervisorBoundaryIterationGuard';
import { createRunTerminationHandlers } from './runTermination';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const subagentGenerationReserveTokens = readSubagentGenerationReserveTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const afterSupervisorBoundaryIterationGuard =
    createAfterSupervisorBoundaryIterationGuard();
  const runSupervisor = createRunSupervisorNode(config);
  const runTermination = createRunTerminationHandlers();

  const entryAnswer = createEntryAnswerSubgraph(config);
  const resultAnswer = createAnswerNode(config);
  const capabilityNode = createCapabilityNode({
    config,
    onNodeError: runTermination.onNodeError,
    subagentContextWindowTokens,
    subagentGenerationReserveTokens,
  });
  // Graph-visible anchor shared by resume and post-execution paths. Its
  // conditional edge owns deterministic guard evaluation and telemetry only;
  // it must not grow state updates or user-facing output.
  const supervisorBoundaryIterationGuard = () => ({});

  const graph = new StateGraph(OrchestratorState, agentRuntimeContextSchema)
    .addNode('prepare', prepare, { ends: ['capability', 'answer', 'compactContext'] })
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
    .addNode('pauseGate', pauseGate)
    .addEdge(START, 'prepare')
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // message/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      supervisorBoundaryIterationGuard: 'supervisorBoundaryIterationGuard',
      captureUserRequest: 'captureUserRequest',
      runSupervisor: 'runSupervisor',
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
      pauseGate: 'pauseGate',
      supervisorBoundaryIterationGuard: 'supervisorBoundaryIterationGuard',
    })
    .addConditionalEdges('pauseGate', afterPauseGate, {
      capability: 'capability',
      answer: 'answer',
    });

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
