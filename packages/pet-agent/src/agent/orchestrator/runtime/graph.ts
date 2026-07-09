import { StateGraph, START, END } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  OrchestratorState,
  type OrchestratorStateType,
} from '../state';
import {
  asDecisionNode,
  createControlContextBuilder,
  type OrchestratorDecision,
} from '../controlPrimitives';
import type {
  OrchestratorConfig,
} from '../types';
import {
  createOrchestrationDecisionRunner,
  createRouteDecisionRunner,
  createTaskDecisionRunner,
} from './decisions/orchestrationDecision';
import {
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
} from './constants';
import {
  readRunIterationLimit,
  readSubagentContextWindowTokens,
} from './config';
import { createAnswerNode } from './nodes/answer';
import { createCapabilitySearchNode } from './nodes/capabilitySearch';
import { createCapabilityNode } from './nodes/capability';
import { createGeneralNode } from './nodes/general';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterDecision } from './routes/afterDecision';
import { createAfterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';
import { afterTaskDecision } from './routes/afterTaskDecision';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const buildControlContext = createControlContextBuilder(orchestratorMaxIterations);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const afterDelegationOutcomeIterationGuard =
    createAfterDelegationOutcomeIterationGuard({ orchestratorMaxIterations });
  const capabilitySearch = createCapabilitySearchNode({ config });
  const runOrchestrationDecision = createOrchestrationDecisionRunner(config);
  const runTaskDecision = createTaskDecisionRunner(config);
  const runRouteDecision = createRouteDecisionRunner(config);

  // Decision nodes write state patches; graph-local route helpers keep the
  // control-flow shape visible in this builder.
  const taskDecision: OrchestratorDecision = (state, ctx) => {
    return runTaskDecision(state, ctx.runnableConfig);
  };

  const routeDecision: OrchestratorDecision = (state, ctx) => {
    return runRouteDecision(state, ctx.runnableConfig);
  };

  const delegationOutcomeDecision = (
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) => {
    return runOrchestrationDecision('delegation_outcome', state, runnableConfig);
  };

  const answerNode = createAnswerNode(config);
  const capabilityNode = createCapabilityNode({ config, subagentContextWindowTokens });
  const generalNode = createGeneralNode({ config, subagentContextWindowTokens });

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('taskDecision', asDecisionNode(taskDecision, buildControlContext))
    .addNode('capabilitySearch', capabilitySearch)
    .addNode('routeDecision', asDecisionNode(routeDecision, buildControlContext))
    .addNode('delegationOutcomeIterationGuard', () => ({}))
    .addNode('delegationOutcomeDecision', delegationOutcomeDecision, {
      ends: ['capability', 'general', 'taskDecision', 'answer'],
    })
    .addNode('answer', answerNode)
    .addNode('capability', capabilityNode)
    .addNode('general', generalNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'compactContext')
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // transcript/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      delegationOutcomeIterationGuard: 'delegationOutcomeIterationGuard',
      taskDecision: 'taskDecision',
    })
    .addConditionalEdges('taskDecision', afterTaskDecision, {
      answer: 'answer',
      capabilitySearch: 'capabilitySearch',
    })
    .addConditionalEdges('delegationOutcomeIterationGuard', afterDelegationOutcomeIterationGuard, {
      answer: 'answer',
      delegationOutcomeDecision: 'delegationOutcomeDecision',
    })
    .addConditionalEdges('routeDecision', afterDecision, {
      answer: 'answer',
      capability: 'capability',
      general: 'general',
    })
    .addEdge('answer', END)
    .addEdge('capabilitySearch', 'routeDecision')
    .addEdge('capability', 'delegationOutcomeIterationGuard')
    .addEdge('general', 'delegationOutcomeIterationGuard');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
