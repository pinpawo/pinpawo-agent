import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import type { SupervisorInvocationState } from './supervisorState';

export const DELEGATE_CAPABILITY_TOOL_NAME = 'delegate_capability';
export const delegationToolSchema = z.object({
  capability: z.string().min(1), task: z.string().min(1),
}).strict();
export type SupervisorDelegationYield = {
  readonly kind: 'capability_tool_handoff';
  readonly toolCallId: string;
  readonly delegationId: string;
  readonly messages: BaseMessage[];
  readonly disclosedCapabilityNames: string[];
};

/**
 * Yield the real tool call to the graph-visible executor adapter. No placeholder
 * ToolMessage: the executor's committed result closes this exact pending call.
 */
export function createDelegationTool(onHandoff: (handoff: SupervisorDelegationYield) => void) {
  return tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => {
    const pending = runtime.state.currentInput.pendingDelegation;
    if (!pending || args.capability !== pending.capability || args.task !== pending.task) {
      throw new Error('Delegation must match the current validated task.');
    }
    if (!runtime.toolCallId) throw new Error('Delegation requires a stable tool call id.');
    const handoff: SupervisorDelegationYield = {
      kind: 'capability_tool_handoff',
      toolCallId: runtime.toolCallId,
      delegationId: pending.delegationId,
      messages: runtime.state.messages,
      disclosedCapabilityNames: runtime.state.disclosedCapabilityNames ?? [],
    };
    onHandoff(handoff);
    // The typed runner seam carries the payload. The parent Command is only a
    // control-flow signal, not a second write of private history to Root state.
    return new Command({
      graph: Command.PARENT,
      update: {},
    });
  }, {
    name: DELEGATE_CAPABILITY_TOOL_NAME,
    description: '执行当前已确认的 Capability task。参数必须与 pending delegation 一致。返回本次实际执行结果，由你继续验收；执行返回不等于任务已完成。此调用必须独占本次响应。',
    schema: delegationToolSchema,
  });
}
