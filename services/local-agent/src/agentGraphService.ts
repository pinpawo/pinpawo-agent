import {
  buildOrchestratorRunInput,
  createOrchestratorGraph,
  buildAgentRunnableConfig,
  readPendingInterrupt,
  settleAbortedRun,
  type AgentRunResult,
  type OrchestratorGraph,
  type OrchestratorStateType,
  type AbortSettlement,
  type PendingInterrupt,
} from '@pinpawo/pet-agent';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, type GraphRunStream } from '@langchain/langgraph';
import type { AgentPlan } from '@pinpawo/agent-session';
import type { AgentChannelSetup } from './agentChannel';
import { LOCAL_AGENT_INTERFACE_CONFIG_KEY } from './chatInterface';
import { projectCurrentPlan } from './currentPlanProjection';
import { createLangfuseCallbacks } from './langfuseTracing';

const HEADLESS_REVIEW_CAPABILITIES = {
  humanReview: false,
  sessionAuthorization: true,
};

function resolveReviewCapabilities(setup: AgentChannelSetup) {
  return setup.interfaceContext?.kind
    ? setup.interfaceContext.capabilities
    : HEADLESS_REVIEW_CAPABILITIES;
}

function buildAgentGraphRunConfig(setup: AgentChannelSetup) {
  const config = buildAgentRunnableConfig(setup.input, {
    registry: setup.registry,
    reviewCapabilities: resolveReviewCapabilities(setup),
  });
  return {
    ...config,
    configurable: {
      ...config.configurable,
      ...(setup.interfaceContext?.kind
        ? { [LOCAL_AGENT_INTERFACE_CONFIG_KEY]: setup.interfaceContext }
        : {}),
    },
  };
}

export function buildAgentGraphConfigurable(setup: AgentChannelSetup) {
  return buildAgentGraphRunConfig(setup).configurable;
}

export type LocalAgentGraphThreadState = {
  messages: BaseMessage[];
  /**
   * The interrupt this thread is waiting on, of any kind, decoded by the
   * Runtime. The Host forwards it without reading `payload.kind`.
   */
  pendingInterrupt: PendingInterrupt | null;
  /**
   * Whether the graph has work a resume command can be delivered to. This is
   * not an interruption signal and must never be used to infer one: a resume
   * that arrives after the graph already consumed its interrupt still has a
   * pending task to resume into.
   */
  acceptsResume: boolean;
  currentPlan: AgentPlan | null;
};

function acceptsResume(snapshot: unknown) {
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

export class LocalAgentGraphService {
  async run(setup: AgentChannelSetup): Promise<AgentRunResult> {
    const state = await this.invokeState(setup);
    const messages = state.messages ?? [];
    const content = messages.at(-1)?.content;
    return { messages, reply: typeof content === 'string' ? content.trim() : '' };
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
    const graph = createOrchestratorGraph(setup.graphConfig);
    const callbacks = createLangfuseCallbacks({
      ...(setup.input.threadId ? { sessionId: setup.input.threadId } : {}),
      ...(setup.traceUserId ? { userId: setup.traceUserId } : {}),
      metadata: {
        interface: setup.interfaceContext?.kind ?? 'headless',
      },
    });
    return await graph.streamEvents(
      (inputOverride === undefined
        ? buildOrchestratorRunInput(setup.input.messages, setup.input)
        : inputOverride) as Parameters<OrchestratorGraph['streamEvents']>[0],
      {
        version: 'v3',
        ...buildAgentGraphRunConfig(setup),
        ...(callbacks ? { callbacks } : {}),
      },
    ) as LocalAgentGraphEventStream;
  }

  async invokeState(setup: AgentChannelSetup, inputOverride?: unknown): Promise<OrchestratorStateType> {
    const graph = createOrchestratorGraph(setup.graphConfig);
    return await graph.invoke(
      inputOverride === undefined
        ? buildOrchestratorRunInput(setup.input.messages, setup.input)
        : inputOverride,
      buildAgentGraphRunConfig(setup),
    ) as OrchestratorStateType;
  }

  private async getRawState(setup: AgentChannelSetup) {
    const graph = createOrchestratorGraph(setup.graphConfig);
    return graph.getState({
      configurable: buildAgentGraphConfigurable(setup),
    });
  }

  async readThreadState(setup: AgentChannelSetup): Promise<LocalAgentGraphThreadState> {
    const snapshot = await this.getRawState(setup);
    const values = readSnapshotValues(snapshot);
    return {
      messages: readSnapshotMessages(snapshot),
      pendingInterrupt: readPendingInterrupt(snapshot),
      acceptsResume: acceptsResume(snapshot),
      currentPlan: projectCurrentPlan(values),
    };
  }

  async updateState(
    setup: AgentChannelSetup,
    values: Partial<OrchestratorStateType>,
    asNode?: string,
  ) {
    const graph = createOrchestratorGraph(setup.graphConfig);
    return graph.updateState(
      {
        configurable: buildAgentGraphConfigurable(setup),
      },
      values,
      asNode,
    );
  }

  /**
   * Turn a cancelled invocation into a pending interrupt when it left work
   * behind. The Runtime owns the mechanism; the Host only says which thread
   * settled and forwards the result.
   */
  settleAbortedRun(setup: AgentChannelSetup): Promise<AbortSettlement> {
    return settleAbortedRun({
      getState: () => this.getRawState(setup),
      updateState: (values, asNode) => this.updateState(
        setup,
        values as Partial<OrchestratorStateType>,
        asNode,
      ),
      resume: () => this.invokeState(setup, null),
    });
  }

  buildResumeCommand(resume: unknown) {
    return new Command({
      resume,
    });
  }
}
