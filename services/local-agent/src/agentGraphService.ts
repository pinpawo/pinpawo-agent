import {
  buildOrchestratorRunInput,
  createOrchestratorGraph,
  buildAgentRunnableConfig,
  readPendingInterrupt,
  settleAbortedRun,
  type OrchestratorGraph,
  type OrchestratorStateType,
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

/**
 * A person's reply to a pending interrupt, in the Host's own terms. The
 * interrupt's kind owns what `value` means; the Host neither reads nor
 * builds it, and the LangGraph `Command` is built at the adapter boundary
 * inside this service.
 */
export type InterruptResume = {
  interruptId: string;
  value: unknown;
};

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

/**
 * The LangGraph adaptation of a person's reply. Keeping it here means no
 * caller above this service constructs an id-keyed resume map or a `Command`.
 */
function buildResumeCommand(resume: InterruptResume) {
  return new Command({
    resume: { [resume.interruptId]: resume.value },
  });
}

export class LocalAgentGraphService {
  /**
   * Root streamEvents(v3) consumption — the production path since #322
   * Phase 4 replaced the legacy `graph.stream(['messages','values','custom'])`
   * + `onToolEvent` bridge. Raw protocol events carry every scope's
   * messages/tools/custom/values with namespaces; consumers adapt them via
   * `adaptRootStream`.
   */
  async streamEvents(
    setup: AgentChannelSetup,
    resume?: InterruptResume,
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
      (resume === undefined
        ? buildOrchestratorRunInput(setup.input.messages, setup.input)
        : buildResumeCommand(resume)) as Parameters<OrchestratorGraph['streamEvents']>[0],
      {
        version: 'v3',
        ...buildAgentGraphRunConfig(setup),
        ...(callbacks ? { callbacks } : {}),
      },
    ) as LocalAgentGraphEventStream;
  }

  private async invokeState(setup: AgentChannelSetup, inputOverride?: unknown): Promise<OrchestratorStateType> {
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
   * Report any real interrupt already checkpointed when cancellation settled.
   * Never rewrite the checkpoint or execute another graph step here.
   */
  settleAbortedRun(setup: AgentChannelSetup): Promise<PendingInterrupt | null> {
    // Reading the settled checkpoint must not inherit the cancelled signal.
    const { signal: _abortedSignal, ...settlementInput } = setup.input;
    const settlementSetup: AgentChannelSetup = {
      ...setup,
      input: settlementInput,
    };
    return settleAbortedRun({
      getState: () => this.getRawState(settlementSetup),
    });
  }
}
