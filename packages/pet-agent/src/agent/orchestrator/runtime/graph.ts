import { StateGraph, START, END } from '@langchain/langgraph';
import { agentRuntimeContextSchema } from '../../../runtime/context';
import {
  OrchestratorState,
} from '../state';
import type {
  OrchestratorConfig,
} from '../types';
import {
  readSubagentContextWindowTokens,
  readSubagentGenerationReserveTokens,
} from './config';
import { createAnswerNode } from './nodes/answer';
import { createDelegateCapabilityTool } from '../runSupervisor/delegateCapabilityTool';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { recoverCapabilityError } from './capabilityError';
import { createRunSupervisorNode } from './nodes/runSupervisor';
import {
  captureRunUserRequest,
  createEntryAnswerSubgraph,
} from './nodes/entryAnswer';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterCapability } from './routes/afterCapability';
import { pauseGate } from './nodes/pauseGate';
import { createRunTerminationHandlers } from './runTermination';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const subagentGenerationReserveTokens = readSubagentGenerationReserveTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const delegateCapability = createDelegateCapabilityTool({
    ...config, subagentContextWindowTokens, subagentGenerationReserveTokens,
  });
  const runSupervisor = createRunSupervisorNode(config, delegateCapability);
  const runTermination = createRunTerminationHandlers();

  const entryAnswer = createEntryAnswerSubgraph(config);
  const resultAnswer = createAnswerNode();

  const graph = new StateGraph(OrchestratorState, agentRuntimeContextSchema)
    .addNode('prepare', prepare, { ends: ['answer', 'compactContext', 'throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('compactContext', compactContext, { ends: ['answer', 'throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('captureUserRequest', captureRunUserRequest, { ends: ['answer', 'throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('entryAnswer', entryAnswer, {
      ends: ['runSupervisor', 'answer', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('runSupervisor', runSupervisor, {
      ends: ['answer', 'capability', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('answer', resultAnswer, {
      ends: ['throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('capability', new ToolNode<typeof OrchestratorState.State>([delegateCapability], { handleToolErrors: false }), {
      ends: ['runSupervisor', 'throwRunFailure', 'answer'],
      errorHandler: (state: typeof OrchestratorState.State, error) => recoverCapabilityError(state, error) ?? runTermination.onNodeError(state, error),
    })
    .addNode('throwRunFailure', runTermination.throwRunFailure)
    .addNode('pauseGate', pauseGate, { ends: ['answer', 'throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addEdge(START, 'prepare')
    // Every fresh run enters Entry Answer. Native resume uses its checkpoint.
    .addEdge('compactContext', 'captureUserRequest')
    .addEdge('captureUserRequest', 'entryAnswer')
    .addEdge('entryAnswer', END)
    .addEdge('answer', END)
    .addConditionalEdges('capability', afterCapability, {
      pauseGate: 'pauseGate',
      runSupervisor: 'runSupervisor',
    })
    .addEdge('pauseGate', 'runSupervisor');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
