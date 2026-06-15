import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
  isHumanReviewInterruptPayload,
  runAgent,
  type AgentRunResult,
  type OrchestratorGraph,
  type OrchestratorStateType,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { ZodType } from 'zod';
import type { AgentChannelSetup } from './agentChannel';
import { LOCAL_AGENT_INTERFACE_CONFIG_KEY } from './chatInterface';

function parseArtifactContent(content: string | null): unknown {
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function buildConfigurable(setup: AgentChannelSetup) {
  const configurable: Record<string, unknown> = {};
  configurable.actor = setup.input.actor;
  if (setup.input.threadId) configurable.thread_id = setup.input.threadId;
  if (setup.input.capabilities) configurable.capabilities = setup.input.capabilities;
  if (setup.input.toolkits && setup.input.toolkits.length > 0) configurable.toolkits = setup.input.toolkits;
  if (setup.input.execution) configurable.execution = setup.input.execution;
  if (setup.input.workdir) configurable.workdir = setup.input.workdir;
  if (setup.input.runtimeEnvironment) configurable.runtimeEnvironment = setup.input.runtimeEnvironment;
  if (setup.input.onToolEvent) configurable.onToolEvent = setup.input.onToolEvent;
  if (setup.interfaceContext?.kind) {
    configurable[LOCAL_AGENT_INTERFACE_CONFIG_KEY] = setup.interfaceContext;
  }
  return Object.keys(configurable).length > 0 ? configurable : undefined;
}

export type LocalAgentGraphPendingHumanReview = {
  review: ReviewSpec;
};

export type LocalAgentGraphThreadState = {
  messages: BaseMessage[];
  pendingHumanReview: LocalAgentGraphPendingHumanReview | null;
  hasPendingContinuation: boolean;
};

function readSnapshotMessages(snapshot: unknown): BaseMessage[] {
  const values = (snapshot as { values?: { messages?: unknown } } | null)?.values;
  const messages = values?.messages;
  return Array.isArray(messages) ? messages as BaseMessage[] : [];
}

function readPendingInterrupt(snapshot: unknown): Record<string, unknown> | null {
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
      return first.value as Record<string, unknown>;
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

function readPendingHumanReview(snapshot: unknown): LocalAgentGraphPendingHumanReview | null {
  const pendingInterrupt = readPendingInterrupt(snapshot);
  if (!pendingInterrupt || !isHumanReviewInterruptPayload(pendingInterrupt)) {
    return null;
  }
  return {
    review: pendingInterrupt.review,
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
    return runAgent(this.getGraph(setup), setup.input);
  }

  async *stream(setup: AgentChannelSetup, inputOverride?: unknown): AsyncGenerator<unknown> {
    const graph = this.getGraph(setup);
    const stream = await graph.stream(
      inputOverride ?? buildOrchestratorTurnInput(setup.input.messages),
      {
        signal: setup.input.signal,
        configurable: buildConfigurable(setup),
        streamMode: ['messages', 'values'],
      },
    );
    for await (const chunk of stream as AsyncIterable<unknown>) {
      yield chunk;
    }
  }

  async invokeState(setup: AgentChannelSetup, inputOverride?: unknown): Promise<OrchestratorStateType> {
    const graph = this.getGraph(setup);
    return await graph.invoke(
      inputOverride ?? buildOrchestratorTurnInput(setup.input.messages),
      {
        signal: setup.input.signal,
        configurable: buildConfigurable(setup),
      },
    ) as OrchestratorStateType;
  }

  private async getRawState(setup: AgentChannelSetup) {
    const graph = this.getGraph(setup);
    return graph.getState({
      configurable: buildConfigurable(setup),
    });
  }

  async readThreadState(setup: AgentChannelSetup): Promise<LocalAgentGraphThreadState> {
    const snapshot = await this.getRawState(setup);
    return {
      messages: readSnapshotMessages(snapshot),
      pendingHumanReview: readPendingHumanReview(snapshot),
      hasPendingContinuation: hasPendingContinuation(snapshot),
    };
  }

  async readThreadMessages(setup: AgentChannelSetup): Promise<BaseMessage[]> {
    const state = await this.readThreadState(setup);
    return state.messages;
  }

  async updateState(
    setup: AgentChannelSetup,
    values: Partial<OrchestratorStateType>,
    asNode?: string,
  ) {
    const graph = this.getGraph(setup);
    return graph.updateState(
      {
        configurable: buildConfigurable(setup),
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

  async invokeStructuredResult<T extends Record<string, unknown>>(
    setup: AgentChannelSetup,
    schema: ZodType<T>,
  ): Promise<{ state: OrchestratorStateType; result: T | null }> {
    const state = await this.invokeState(setup);
    const latestResultRef = [...state.capabilityArtifacts]
      .reverse()
      .find((artifact) => artifact.kind === 'result');
    const artifactContent = latestResultRef && setup.graphConfig.capabilityArtifactStore?.readArtifact
      ? setup.graphConfig.capabilityArtifactStore.readArtifact({
          uri: latestResultRef.uri,
          threadId: setup.input.threadId,
        }).content
      : null;
    const parsed = artifactContent !== null
      ? schema.safeParse(parseArtifactContent(artifactContent))
      : null;

    return {
      state,
      result: parsed?.success ? parsed.data : null,
    };
  }
}
