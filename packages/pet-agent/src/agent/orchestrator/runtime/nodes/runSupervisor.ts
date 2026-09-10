import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCapabilityCatalog } from '../../runSupervisor/capabilityCatalog';
import { createRunSupervisorAgent } from '../../runSupervisor/agent';
import { resolveCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import { acceptSupervisorMessageHandoff } from '../../runSupervisor/messageHandoff';
import { buildRunSupervisorInput, isSupervisorDispatch, supervisorHandoffContext } from '../../runSupervisor/input';
import type { RunSupervisorDispatch } from '../../runSupervisor/runner';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { getInvokeOptions, getInvokeRegistry } from '../config';
import { getAgentMessageMetadata } from '../../../messages';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../constants';

export function createRunSupervisorNode(config: OrchestratorConfig) {
  const runner = config.runSupervisorRunner ?? createRunSupervisorAgent({
    model: config.models.act, defaultCapabilityName: config.defaultCapabilityName,
  });
  return async (nodeInput: OrchestratorStateType | RunSupervisorDispatch, runnableConfig?: RunnableConfig) => {
    const root = isSupervisorDispatch(nodeInput) ? nodeInput.root : nodeInput;
    if (!isSupervisorDispatch(nodeInput) && !root.runSupervisorState.plan.length) {
      return new Command({ update: { runRuntimeFailure: 'checkpoint_incompatible' }, goto: 'answer' });
    }
    if (root.runIterationCount >= ORCHESTRATOR_MAX_ITERATIONS) return new Command({ goto: 'answer' });
    const catalog = createCapabilityCatalog({
      registry: getInvokeRegistry(runnableConfig),
      allowedCapabilityNames: getInvokeOptions(runnableConfig).allowedCapabilityNames,
    });
    const input = buildRunSupervisorInput({ nodeInput, catalog,
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
      runUserRequest: input.userRequest,
    };
    if (result.reply !== undefined) {
      const last = result.messages.at(-1);
      if (!result.reply.trim() || !AIMessage.isInstance(last) || last.tool_calls?.length || last.text !== result.reply) {
        throw new Error('Supervisor final reply must match its actual final AIMessage.');
      }
      return new Command({ update: { ...common, messages: result.messages, runSupervisorReply: result.reply }, goto: 'answer' });
    }
    const accepted = acceptSupervisorMessageHandoff(supervisorHandoffContext(input), result.messages);
    return new Command({
      update: {
        ...common, runSupervisorState: accepted.runSupervisorState,
        messages: [...result.messages.slice(0, -accepted.messages.length), ...accepted.messages],
        runSupervisorReply: accepted.reply,
      },
      goto: accepted.reply ? 'answer' : 'capability',
    });
  };
}
