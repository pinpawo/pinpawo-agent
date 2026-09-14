import { AIMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata, stampAgentMessageCreatedAt } from '../../../messages';
import { Command, END } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createCapabilityCatalog } from '../../runSupervisor/capabilityCatalog';
import { createRunSupervisorAgent } from '../../runSupervisor/agent';
import { resolveCapabilityDisclosureState } from '../../runSupervisor/capabilityDisclosure';
import type { StructuredTool } from '@langchain/core/tools';
import { buildRunSupervisorInput } from '../../runSupervisor/input';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { getInvokeOptions, getInvokeRegistry } from '../config';
import { runIterationBudgetReached } from '../guards/runIterationBudget';

export function createRunSupervisorNode(config: OrchestratorConfig, delegateCapabilityTool?: StructuredTool) {
  const runner = config.runSupervisorRunner ?? createRunSupervisorAgent({
    model: config.models.act, defaultCapabilityName: config.defaultCapabilityName, delegateCapabilityTool,
  });
  return async (root: OrchestratorStateType, runnableConfig?: RunnableConfig) => {
    if (runIterationBudgetReached(root, runnableConfig)) return new Command({
      update: { messages: [setAgentMessageMetadata(stampAgentMessageCreatedAt(new AIMessage(
        '主流程循环已达到上限，任务尚未验收完成。你可以继续当前任务。',
      )), { runId: root.runId, traceId: root.traceId })], runTerminalError: null },
      goto: END,
    });
    const catalog = createCapabilityCatalog({
      registry: getInvokeRegistry(runnableConfig),
      allowedCapabilityNames: getInvokeOptions(runnableConfig).allowedCapabilityNames,
    });
    const input = buildRunSupervisorInput({ root, catalog,
      capabilityDisclosure: resolveCapabilityDisclosureState({ current: root.runCapabilityDisclosure, catalog }),
    });
    const result = await runner.invoke(input, runnableConfig);
    // Execution leaves through native Command.PARENT; normal return is the final reply.
    return new Command({
      update: {
        runCapabilityDisclosure: result.capabilityDisclosure,
        runSupervisorUserMessageId: input.inputId.startsWith('human:') ? input.inputId : root.runSupervisorUserMessageId,
        runSupervisorState: result.runSupervisorState,
        runSupervisorReviewFeedback: result.reviewFeedback ?? null,
        messages: result.messages,
      },
      goto: END,
    });
  };
}
