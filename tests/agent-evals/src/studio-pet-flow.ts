import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CompiledAgentRegistry } from '../../../packages/pet-agent/src/agent/orchestrator/registry.ts';
import type { AgentModels } from '../../../packages/pet-agent/src/types/agent.ts';
import type { AgentRuntimeContext } from '../../../packages/pet-agent/src/runtime/context.ts';
import { createOrchestratorGraph } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts';
import { buildOrchestratorRunInput } from '../../../packages/pet-agent/src/agent/orchestrator/state.ts';
import { buildAgentRunnableConfig } from '../../../packages/pet-agent/src/agent/runAgent.ts';

/** Real root/child transitions with controlled subtask evidence, not domain execution. */
export async function runStudioPetFlow(params: {
  model: AgentModels['act'];
  registry: CompiledAgentRegistry;
  defaultCapabilityName: string;
  context: AgentRuntimeContext;
  messages: BaseMessage[];
  deliveries: Record<string, string>;
  maxDelegations?: number;
  config?: RunnableConfig;
}) {
  let calls = 0;
  const limit = new AbortController();
  const signal = params.config?.signal ? AbortSignal.any([params.config.signal, limit.signal]) : limit.signal;
  class DeliveryModel extends BaseChatModel {
    _llmType() { return 'synthetic-capability-delivery'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      // Identify the actual selected Capability by its dynamic compiled body,
      // not prompt wording or an expected sequence of model decisions.
      const system = messages.filter(message => message._getType() === 'system').map(message => message.text).join('\n');
      const selected = params.registry.capabilities.filter(item => system.includes(item.capability.instructions.content));
      if (selected.length !== 1) throw new Error('Cannot identify the executing fixture Capability.');
      const name = selected[0]!.capability.name;
      const delivery = params.deliveries[name];
      if (delivery === undefined) throw new Error(`No synthetic delivery configured for ${name}.`);
      if (++calls > (params.maxDelegations ?? 4)) {
        const error = new Error('Synthetic Capability delivery budget exhausted.');
        limit.abort(error);
        throw error;
      }
      return { generations: [{ message: new AIMessage(delivery), text: delivery }] };
    }
  }
  const graph = createOrchestratorGraph({
    models: { act: params.model, answer: params.model, subagent: new DeliveryModel({}) },
    defaultCapabilityName: params.defaultCapabilityName,
  });
  const input = { messages: params.messages, context: params.context, signal };
  return graph.invoke(buildOrchestratorRunInput(input.messages), {
    ...params.config, ...buildAgentRunnableConfig(input, { registry: params.registry }),
    recursionLimit: params.config?.recursionLimit ?? 40,
  });
}
