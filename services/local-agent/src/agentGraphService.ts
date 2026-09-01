import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  ORCHESTRATOR_RECURSION_LIMIT,
  runAgent,
  type AgentRunResult,
  type OrchestratorGraph,
  type OrchestratorStateType,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, type GraphRunStream } from '@langchain/langgraph';
import type { AgentPlan } from '@pinpawo/agent-session';
import type { AgentChannelSetup } from './agentChannel';
import { LOCAL_AGENT_INTERFACE_CONFIG_KEY } from './chatInterface';
import { projectCurrentPlan } from './currentPlanProjection';

const HEADLESS_REVIEW_CAPABILITIES = {
  humanReview: false,
  sessionAuthorization: true,
};

function resolveReviewCapabilities(setup: AgentChannelSetup) {
  return setup.interfaceContext?.kind
    ? setup.interfaceContext.capabilities
    : HEADLESS_REVIEW_CAPABILITIES;
}

export function buildAgentGraphConfigurable(setup: AgentChannelSetup) {
  const configurable: Record<string, unknown> = {};
  configurable.registry = setup.registry;
  configurable.actor = setup.input.actor;
  if (setup.input.threadId) configurable.thread_id = setup.input.threadId;
  if (setup.input.execution) configurable.execution = setup.input.execution;
  if (setup.input.workdir) configurable.workdir = setup.input.workdir;
  if (setup.input.runtimeEnvironment) configurable.runtimeEnvironment = setup.input.runtimeEnvironment;
  if (setup.input.globalReviewPolicy) configurable.globalReviewPolicy = setup.input.globalReviewPolicy;
  if (setup.interfaceContext?.kind) {
    configurable[LOCAL_AGENT_INTERFACE_CONFIG_KEY] = setup.interfaceContext;
  }
  configurable.reviewCapabilities = resolveReviewCapabilities(setup);
  return Object.keys(configurable).length > 0 ? configurable : undefined;
}

export type LocalAgentGraphPendingInterrupt = {
  interruptId: string;
  reviews: ReviewSpec[];
};

export type LocalAgentGraphThreadState = {
  messages: BaseMessage[];
  pendingInterrupt: LocalAgentGraphPendingInterrupt | null;
  hasPendingContinuation: boolean;
  currentPlan: AgentPlan | null;
};

/**
 * The root v3 run stream. The GraphRunStream projections (raw protocol
 * iteration, subgraphs, interrupts, output) stay available to consumers.
 */
export type LocalAgentGraphEventStream = GraphRunStream<OrchestratorStateType>;

function readSnapshotMessages(snapshot: unknown): BaseMessage[] {
  const values = readSnapshotValues(snapshot);
  const messages = values?.messages;
  return Array.isArray(messages) ? messages as BaseMessage[] : [];
}

function readSnapshotValues(snapshot: unknown): Record<string, unknown> | null {
  const values = (snapshot as { values?: unknown } | null)?.values;
  return values && typeof values === 'object' && !Array.isArray(values)
    ? values as Record<string, unknown>
    : null;
}

function readGraphInterrupt(snapshot: unknown): { id: string; value: Record<string, unknown> } | null {
  const tasks = Array.isArray((snapshot as { tasks?: unknown } | null)?.tasks)
    ? (snapshot as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (first && typeof first === 'object' && 'value' in first && first.value && typeof first.value === 'object') {
      const interrupt = first as { id?: unknown; value: unknown };
      if (typeof interrupt.id !== 'string' || !interrupt.id) return null;
      return { id: interrupt.id, value: interrupt.value as Record<string, unknown> };
    }
  }
  return null;
}

function hasPendingContinuation(snapshot: unknown) {
  const record = snapshot && typeof snapshot === 'object'
    ? snapshot as { next?: unknown; tasks?: unknown }
    : null;
  const next = Array.isArray(record?.next) ? record.next : [];
  if (next.length > 0) {
    return true;
  }
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  return tasks.length > 0;
}

function projectPendingInterrupt(snapshot: unknown): LocalAgentGraphPendingInterrupt | null {
  const pendingInterrupt = readGraphInterrupt(snapshot);
  if (!pendingInterrupt) {
    return null;
  }
  if (isHumanReviewBatchInterruptPayload(pendingInterrupt.value)) {
    const reviews = pendingInterrupt.value.reviews.map((item) => item.review);
    const review = reviews[0];
    if (!review) {
      return null;
    }
    return {
      interruptId: pendingInterrupt.id,
      reviews,
    };
  }
  if (!isHumanReviewInterruptPayload(pendingInterrupt.value)) {
    return null;
  }
  return {
    interruptId: pendingInterrupt.id,
    reviews: [pendingInterrupt.value.review],
  };
}

export class LocalAgentGraphService {
  private readonly graphs = new Map<string, OrchestratorGraph>();

  private getGraph(setup: AgentChannelSetup) {
    const cached = this.graphs.get(setup.graphKey);
    if (cached) {
      return cached;
    }

    const graph = createOrchestratorGraph(setup.graphConfig);
    this.graphs.set(setup.graphKey, graph);
    return graph;
  }

  async run(setup: AgentChannelSetup): Promise<AgentRunResult> {
    return runAgent(this.getGraph(setup), setup.input, {
      registry: setup.registry,
      reviewCapabilities: resolveReviewCapabilities(setup),
    });
  }

  /**
   * Root streamEvents(v3) consumption — the production path since #322
   * Phase 4 replaced the legacy `graph.stream(['messages','values','custom'])`
   * + `onToolEvent` bridge. Raw protocol events carry every scope's
   * messages/tools/custom/values with namespaces; consumers adapt them via
   * `adaptRootStream`.
   */
  async streamEvents(
    setup: AgentChannelSetup,
    inputOverride?: unknown,
  ): Promise<LocalAgentGraphEventStream> {
    const graph = this.getGraph(setup);
    return await graph.streamEvents(
      (inputOverride ?? buildOrchestratorTurnInput(setup.input.messages, {
        activeDelegationTransition: setup.input.activeDelegationTransition,
      })) as Parameters<OrchestratorGraph['streamEvents']>[0],
      {
        version: 'v3',
        signal: setup.input.signal,
        configurable: buildAgentGraphConfigurable(setup),
        recursionLimit: ORCHESTRATOR_RECURSION_LIMIT,
      },
    ) as LocalAgentGraphEventStream;
  }

  async invokeState(setup: AgentChannelSetup, inputOverride?: unknown): Promise<OrchestratorStateType> {
    const graph = this.getGraph(setup);
    return await graph.invoke(
      inputOverride ?? buildOrchestratorTurnInput(setup.input.messages, {
        activeDelegationTransition: setup.input.activeDelegationTransition,
      }),
      {
        signal: setup.input.signal,
        configurable: buildAgentGraphConfigurable(setup),
        recursionLimit: ORCHESTRATOR_RECURSION_LIMIT,
      },
    ) as OrchestratorStateType;
  }

  private async getRawState(setup: AgentChannelSetup) {
    const graph = this.getGraph(setup);
    return graph.getState({
      configurable: buildAgentGraphConfigurable(setup),
    });
  }

  async readThreadState(setup: AgentChannelSetup): Promise<LocalAgentGraphThreadState> {
    const snapshot = await this.getRawState(setup);
    const values = readSnapshotValues(snapshot);
    return {
      messages: readSnapshotMessages(snapshot),
      pendingInterrupt: projectPendingInterrupt(snapshot),
      hasPendingContinuation: hasPendingContinuation(snapshot),
      currentPlan: projectCurrentPlan(values),
    };
  }

  async updateState(
    setup: AgentChannelSetup,
    values: Partial<OrchestratorStateType>,
    asNode?: string,
  ) {
    const graph = this.getGraph(setup);
    return graph.updateState(
      {
        configurable: buildAgentGraphConfigurable(setup),
      },
      values,
      asNode,
    );
  }

  buildResumeCommand(resume: unknown) {
    return new Command({
      resume,
    });
  }
}
