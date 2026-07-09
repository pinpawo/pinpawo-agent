import { StateGraph, START, END } from '@langchain/langgraph';
import {
  OrchestratorState,
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
import {
  createDelegationOutcomeIterationGuardNode,
} from './guards/nodes';
import { createAnswerNode } from './nodes/answer';
import { createCapabilitySearchNode } from './nodes/capabilitySearch';
import { createCapabilityNode } from './nodes/capability';
import { finalizeRun } from './nodes/finalize';
import { createGeneralNode } from './nodes/general';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterDecision } from './routes/afterDecision';
import { afterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';
import { afterTaskDecision } from './routes/afterTaskDecision';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const buildControlContext = createControlContextBuilder(orchestratorMaxIterations);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const delegationOutcomeIterationGuardNode =
    createDelegationOutcomeIterationGuardNode({ orchestratorMaxIterations });
  const capabilitySearch = createCapabilitySearchNode({ config });
  const runOrchestrationDecision = createOrchestrationDecisionRunner(config);
  const runTaskDecision = createTaskDecisionRunner(config);
  const runRouteDecision = createRouteDecisionRunner(config);

  // The two Decision nodes bind the shared decision runner to a decision kind and
  // conform to the OrchestratorDecision contract (state, ctx) -> patch.
  const taskDecision: OrchestratorDecision = (state, ctx) => {
    return runTaskDecision(state, ctx.runnableConfig);
  };

  const routeDecision: OrchestratorDecision = (state, ctx) => {
    return runRouteDecision(state, ctx.runnableConfig);
  };

  const delegationOutcomeDecision: OrchestratorDecision = (state, ctx) => {
    return runOrchestrationDecision('delegation_outcome', state, ctx.runnableConfig);
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
    .addNode('delegationOutcomeIterationGuard', delegationOutcomeIterationGuardNode)
    .addNode('delegationOutcomeDecision', asDecisionNode(delegationOutcomeDecision, buildControlContext))
    .addNode('answer', answerNode)
    .addNode('finalizeRun', finalizeRun)
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
      end: END,
      answer: 'answer',
      capabilitySearch: 'capabilitySearch',
      finalizeRun: 'finalizeRun',
    })
    .addConditionalEdges('delegationOutcomeIterationGuard', afterDelegationOutcomeIterationGuard, {
      end: END,
      delegationOutcomeDecision: 'delegationOutcomeDecision',
      finalizeRun: 'finalizeRun',
    })
    .addConditionalEdges('routeDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      finalizeRun: 'finalizeRun',
      general: 'general',
    })
    .addConditionalEdges('delegationOutcomeDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      finalizeRun: 'finalizeRun',
      general: 'general',
    })
    .addEdge('answer', END)
    .addEdge('finalizeRun', END)
    .addEdge('capabilitySearch', 'routeDecision')
    .addEdge('capability', 'delegationOutcomeIterationGuard')
    .addEdge('general', 'delegationOutcomeIterationGuard');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
