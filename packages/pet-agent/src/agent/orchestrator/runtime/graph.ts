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
  createCapabilityPlanningDecisionRunner,
  createCapabilityDecisionRunner,
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
import { createCapabilityNode } from './nodes/capability';
import {
  createCompactContextNode,
  createPrepareNode,
} from './nodes/prepare';
import { afterContextPrep } from './routes/afterContextPrep';
import { afterCapability } from './routes/afterCapability';
import { afterDecision } from './routes/afterDecision';
import { createAfterDelegationOutcomeIterationGuard } from './routes/afterDelegationOutcomeIterationGuard';

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
  const runOrchestrationDecision = createOrchestrationDecisionRunner(config);
  const runTaskDecision = createTaskDecisionRunner(config);
  const runCapabilityPlanningDecision = createCapabilityPlanningDecisionRunner(config);
  const runCapabilityDecision = createCapabilityDecisionRunner(config);

  // Decision nodes write state patches; graph-local route helpers keep the
  // control-flow shape visible in this builder.
  const capabilityDecision: OrchestratorDecision = (state, ctx) => {
    return runCapabilityDecision(state, ctx.runnableConfig);
  };

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
    .addNode('entryDecision', runTaskDecision, {
      ends: ['answer', 'capabilityPlanner', 'capabilityDecision'],
    })
    .addNode('capabilityPlanner', runCapabilityPlanningDecision, {
      ends: ['answer', 'capabilityDecision'],
    })
    .addNode('capabilityDecision', asDecisionNode(capabilityDecision, buildControlContext))
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
    .addConditionalEdges('capabilityDecision', afterDecision, {
      answer: 'answer',
      capability: 'capability',
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
