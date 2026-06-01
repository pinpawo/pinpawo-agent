import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
  runAgent,
  type AgentRunResult,
  type OrchestratorGraph,
  type OrchestratorStateType,
} from '@pinpawo/pet-agent';
import { Command } from '@langchain/langgraph';
import type { ZodType } from 'zod';
import type { AgentChannelSetup } from './agentChannel';

function buildConfigurable(setup: AgentChannelSetup) {
  const configurable: Record<string, unknown> = {};
  configurable.actor = setup.input.actor;
  if (setup.input.threadId) configurable.thread_id = setup.input.threadId;
  if (setup.input.capabilities) configurable.capabilities = setup.input.capabilities;
  if (setup.input.tools) configurable.tools = setup.input.tools;
  if (setup.input.toolkits) configurable.toolkits = setup.input.toolkits;
  if (setup.input.execution) configurable.execution = setup.input.execution;
  if (setup.input.workdir) configurable.workdir = setup.input.workdir;
  if (setup.input.runtimeEnvironment) configurable.runtimeEnvironment = setup.input.runtimeEnvironment;
  if (setup.input.onToolEvent) configurable.onToolEvent = setup.input.onToolEvent;
  return Object.keys(configurable).length > 0 ? configurable : undefined;
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

  async getState(setup: AgentChannelSetup) {
    const graph = this.getGraph(setup);
    return graph.getState({
      configurable: buildConfigurable(setup),
    });
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
    const parsed = state.capabilityResult
      ? schema.safeParse(state.capabilityResult)
      : null;

    return {
      state,
      result: parsed?.success ? parsed.data : null,
    };
  }
}
