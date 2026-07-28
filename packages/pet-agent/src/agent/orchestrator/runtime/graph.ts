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
  createOrchestrationDecisionRunner,
  createEntryDecisionRunner,
} from './decisions/orchestrationDecision';
import {
  DEFAULT_ORCHESTRATOR_MAX_ITERATIONS,
} from './constants';
import {
  readRunIterationLimit,
  readSubagentContextWindowTokens,
} from './config';
import { createAnswerNode } from './nodes/answer';
import { createCapabilityNode } from './nodes/capability';
import { createCapabilityPlannerNode } from './nodes/capabilityPlanner';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterCapability } from './routes/afterCapability';
import { createAfterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';

// --- Graph builder ---

export function createOrchestratorGraph(config: OrchestratorConfig) {
  const orchestratorMaxIterations = readRunIterationLimit(config.maxRunIterations)
    ?? DEFAULT_ORCHESTRATOR_MAX_ITERATIONS;
  const subagentContextWindowTokens = readSubagentContextWindowTokens(config);
  const prepare = createPrepareNode();
  const compactContext = createCompactContextNode({ config });
  const afterDelegationOutcomeIterationGuard =
    createAfterDelegationOutcomeIterationGuard({ orchestratorMaxIterations });
  const runOrchestrationDecision = createOrchestrationDecisionRunner(config);
  const runEntryDecision = createEntryDecisionRunner(config);
  const runCapabilityPlanner = createCapabilityPlannerNode(config);

  const delegationOutcomeDecision = (
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) => {
    return runOrchestrationDecision('delegation_outcome', state, runnableConfig);
  };

  const answerNode = createAnswerNode(config);
  const capabilityNode = createCapabilityNode({ config, subagentContextWindowTokens });
  // Graph-visible anchor shared by resume and post-execution paths. Its
  // conditional edge owns deterministic guard evaluation and telemetry only;
  // it must not grow state updates or user-facing output.
  const delegationOutcomeIterationGuard = () => ({});

  const graph = new StateGraph(OrchestratorState)
    .addNode('prepare', prepare)
    .addNode('compactContext', compactContext)
    .addNode('entryDecision', runEntryDecision, {
      ends: ['answer', 'capabilityPlanner'],
    })
    .addNode('capabilityPlanner', runCapabilityPlanner, {
      ends: ['answer', 'capability'],
    })
    .addNode('delegationOutcomeIterationGuard', delegationOutcomeIterationGuard)
    .addNode('delegationOutcomeDecision', delegationOutcomeDecision, {
      ends: ['capability', 'capabilityPlanner', 'answer'],
    })
    .addNode('answer', answerNode)
    .addNode('capability', capabilityNode)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'compactContext')
    // Run entry uses explicit task lifecycle state. Lane announces remain
    // transcript/context storage and are not the normal control-flow signal.
    .addConditionalEdges('compactContext', afterContextPrep, {
      delegationOutcomeIterationGuard: 'delegationOutcomeIterationGuard',
      entryDecision: 'entryDecision',
      capability: 'capability',
    })
    .addConditionalEdges('delegationOutcomeIterationGuard', afterDelegationOutcomeIterationGuard, {
      answer: 'answer',
      delegationOutcomeDecision: 'delegationOutcomeDecision',
    })
    .addEdge('answer', END)
    .addConditionalEdges('capability', afterCapability, {
      end: END,
      delegationOutcomeIterationGuard: 'delegationOutcomeIterationGuard',
    });

  return graph.compile({
    checkpointer: config.checkpoint,
  });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;
