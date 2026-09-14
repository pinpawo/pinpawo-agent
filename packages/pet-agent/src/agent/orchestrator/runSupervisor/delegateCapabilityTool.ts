import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas } from './protocol';
import { applySupervisorToolCall, type SupervisorHandoffContext } from './messageHandoff';

export function createDelegateCapabilityTool(context: SupervisorHandoffContext, messageOffset = 0) {
  return tool((args, runtime: ToolRuntime) =>
    applySupervisorToolCall(context, messageOffset, runtime, { name: 'delegate_capability', args }), {
    name: 'delegate_capability',
    schema: supervisorControlSchemas.delegate_capability,
    verboseParsingErrors: true,
    description: '执行当前计划项，将控制权交给 Capability。无需参数；运行时注入已确认的当前任务、按顺序排列的计划与本次补做意见。返回交付后由你继续判断。',
  });
}
