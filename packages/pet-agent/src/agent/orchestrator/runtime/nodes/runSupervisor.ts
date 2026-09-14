import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCapabilityCatalog } from '../../runSupervisor/capabilityCatalog';
import { createRunSupervisorAgent } from '../../runSupervisor/agent';
import { resolveCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import type { StructuredTool } from '@langchain/core/tools';
import { buildRunSupervisorInput } from '../../runSupervisor/input';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { getInvokeOptions, getInvokeRegistry } from '../config';
import { getAgentMessageMetadata } from '../../../messages';
import { runIterationBudgetReached } from '../guards/runIterationBudget';

export function createRunSupervisorNode(config: OrchestratorConfig, delegateCapabilityTool?: StructuredTool) {
  const runner = config.runSupervisorRunner ?? createRunSupervisorAgent({
    model: config.models.act, defaultCapabilityName: config.defaultCapabilityName, delegateCapabilityTool,
  });
  return async (root: OrchestratorStateType, runnableConfig?: RunnableConfig) => {
    if (runIterationBudgetReached(root, runnableConfig)) return new Command({ goto: 'answer' });
    const catalog = createCapabilityCatalog({
      registry: getInvokeRegistry(runnableConfig),
      allowedCapabilityNames: getInvokeOptions(runnableConfig).allowedCapabilityNames,
    });
    const input = buildRunSupervisorInput({ root, catalog,
      capabilityDisclosure: resolveCapabilityDisclosureState({ current: root.runCapabilityDisclosure, catalog }),
    });
    const result = await runner.invoke(input, runnableConfig);
    if (result.capabilityDisclosure.registryDigest !== catalog.registryDigest
      || result.capabilityDisclosure.disclosedCapabilityNames.some((name) => !catalog.capabilityNames.includes(name))) {
      throw new Error('Supervisor disclosure does not match the current catalog.');
    }
    const lastMessage = result.messages.at(-1);
    const working = AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.[0]?.name === 'delegate_capability'
      ? result.messages.slice(0, -1) : result.messages;
    if (working.some((message) => {
      const metadata = getAgentMessageMetadata(message);
      return metadata.lane !== 'supervisor' || metadata.runId !== root.runId || metadata.traceId !== root.traceId;
    })) throw new Error('Supervisor work messages must belong to the current run.');
    const common = {
      runCapabilityDisclosure: result.capabilityDisclosure,
      runSupervisorUserMessageId: input.inputId.startsWith('human:') ? input.inputId : root.runSupervisorUserMessageId,
    };
    const accepted = { ...result, reply: result.reply ?? null };
    if (result.reply !== undefined && (!result.reply.trim() || !AIMessage.isInstance(lastMessage)
      || lastMessage.tool_calls?.length || result.reply !== lastMessage.text)) {
      throw new Error('Supervisor final reply must match its actual final AIMessage.');
    }
    if (!accepted.reply && !(AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.[0]?.name === 'delegate_capability')) {
      throw new Error('Supervisor must reply or explicitly request execution.');
    }
    return new Command({
      update: {
        ...common, runSupervisorState: accepted.runSupervisorState,
        runSupervisorReviewFeedback: result.reviewFeedback ?? null,
        messages: accepted.messages,
      },
      goto: accepted.reply ? 'answer' : 'capability',
    });
  };
}
