import { StateGraph, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import {
  OrchestratorState,
} from '../state';
import {
  asDecisionNode,
  type OrchestratorDecision,
} from '../controlPrimitives';
import type {
  OrchestratorConfig,
} from '../types';
import {
  capabilitySearchTool,
} from '../capabilitySearch';
import { createOrchestrationDecisionRunner } from './decisions/orchestrationDecision';
import {
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
} from './constants';
import {
  readRunIterationLimit,
  readSubagentContextWindowTokens,
} from './config';
import {
  createCompactContextNode,
  createDelegationOutcomeDecisionGuardNode,
  createDelegationOutcomeIterationGuardNode,
  createPrepareNode,
  prepareUserIntentDecision,
} from './guards/nodes';
import { createAnswerNode } from './nodes/answer';
import { createCapabilityNode } from './nodes/capability';
import { createCapabilityDiscoveryNode } from './nodes/capabilityDiscovery';
import { createGeneralNode } from './nodes/general';
import {
  createControlContextBuilder,
  createOrchestratorGuardRegistry,
  createOrchestratorGuardRunner,
} from './guards/runner';
import { afterCapabilityDiscovery } from './routes/afterCapabilityDiscovery';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterDecision } from './routes/afterDecision';
import { afterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const orchestratorGuardRegistry = createOrchestratorGuardRegistry();
  const runOrchestratorGuard = createOrchestratorGuardRunner({
    config,
    orchestratorMaxIterations,
    guardRegistry: orchestratorGuardRegistry,
  });
  const buildControlContext = createControlContextBuilder(orchestratorMaxIterations);
  const prepare = createPrepareNode(runOrchestratorGuard);
  const compactContext = createCompactContextNode({ config, runOrchestratorGuard });
  const delegationOutcomeDecisionGuardNode =
    createDelegationOutcomeDecisionGuardNode(runOrchestratorGuard);
  const delegationOutcomeIterationGuardNode =
    createDelegationOutcomeIterationGuardNode(runOrchestratorGuard);
  const capabilityDiscovery = createCapabilityDiscoveryNode({ config, runOrchestratorGuard });
  const runOrchestrationDecision = createOrchestrationDecisionRunner(config);

  // The two Decision nodes bind the shared decision runner to a decision kind and
  // conform to the OrchestratorDecision contract (state, ctx) -> patch.
  const userIntentDecision: OrchestratorDecision = (state, ctx) => {
    return runOrchestrationDecision('user_intent', state, ctx.runnableConfig);
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
    .addNode('capabilityDiscovery', capabilityDiscovery)
    .addNode('capabilitySearch', new ToolNode([capabilitySearchTool]))
    .addNode('prepareUserIntentDecision', prepareUserIntentDecision)
    .addNode('delegationOutcomeDecisionGuard', delegationOutcomeDecisionGuardNode)
    .addNode('userIntentDecision', asDecisionNode(userIntentDecision, buildControlContext))
    .addNode('delegationOutcomeIterationGuard', delegationOutcomeIterationGuardNode)
    .addNode('delegationOutcomeDecision', asDecisionNode(delegationOutcomeDecision, buildControlContext))
    .addNode('answer', answerNode)
    .addNode('capability', capabilityNode)
    .addNode('general', generalNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'compactContext')
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // transcript/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      delegationOutcomeIterationGuard: 'delegationOutcomeIterationGuard',
      capabilityDiscovery: 'capabilityDiscovery',
    })
    .addConditionalEdges('capabilityDiscovery', afterCapabilityDiscovery, {
      capabilitySearch: 'capabilitySearch',
      prepareUserIntentDecision: 'prepareUserIntentDecision',
    })
    .addEdge('prepareUserIntentDecision', 'userIntentDecision')
    .addConditionalEdges('delegationOutcomeIterationGuard', afterDelegationOutcomeIterationGuard, {
      end: END,
      delegationOutcomeDecisionGuard: 'delegationOutcomeDecisionGuard',
    })
    .addEdge('delegationOutcomeDecisionGuard', 'delegationOutcomeDecision')
    .addConditionalEdges('userIntentDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      general: 'general',
    })
    .addConditionalEdges('delegationOutcomeDecision', afterDecision, {
      end: END,
      answer: 'answer',
      capability: 'capability',
      general: 'general',
    })
    .addEdge('answer', END)
    .addEdge('capabilitySearch', 'prepareUserIntentDecision')
    .addEdge('capability', 'delegationOutcomeIterationGuard')
    .addEdge('general', 'delegationOutcomeIterationGuard');

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
