import { StateGraph, START, END } from '@langchain/langgraph';
import type { InteropZodObject } from '@langchain/core/utils/types';
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
import { delegationBoundary } from './nodes/delegationBoundary';
import { createRunTerminationHandlers } from './runTermination';
import { validateCheckpointInterrupts } from '../interrupt/validateCheckpointInterrupts';

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

  // LangGraph maps a Zod context object's optional keys to required properties
  // whose values may be undefined. Keep the runtime schema, without making a
  // newly optional invocation field mandatory for every graph caller.
  const graph = new StateGraph(OrchestratorState, agentRuntimeContextSchema as InteropZodObject)
    .addNode('prepare', prepare, { ends: ['compactContext', 'throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('compactContext', compactContext, { ends: ['throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('captureUserRequest', captureRunUserRequest, { ends: ['throwRunFailure'], errorHandler: runTermination.onNodeError })
    .addNode('entryAnswer', entryAnswer, {
      ends: ['runSupervisor', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('runSupervisor', runSupervisor, {
      ends: [END, 'capability', 'throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('capability', new ToolNode<typeof OrchestratorState.State>([delegateCapability], { handleToolErrors: false }), {
      ends: ['runSupervisor', 'throwRunFailure'],
      errorHandler: (state: typeof OrchestratorState.State, error) => recoverCapabilityError(state, error) ?? runTermination.onNodeError(state, error),
    })
    .addNode('delegationBoundary', delegationBoundary, {
      ends: ['throwRunFailure'],
      errorHandler: runTermination.onNodeError,
    })
    .addNode('throwRunFailure', runTermination.throwRunFailure)
    .addEdge(START, 'prepare')
    // Every fresh run enters Entry Answer. Native resume uses its checkpoint.
    .addEdge('compactContext', 'captureUserRequest')
    .addEdge('captureUserRequest', 'entryAnswer')
    .addEdge('entryAnswer', END)
    .addConditionalEdges('capability', afterCapability, {
      [END]: END,
      delegationBoundary: 'delegationBoundary',
    })
    .addEdge('delegationBoundary', 'runSupervisor');

  return graph.compile({
    checkpointer: config.checkpoint ? validateCheckpointInterrupts(config.checkpoint) : undefined,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
