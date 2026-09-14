import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas } from './protocol';
import { applySupervisorToolCall, type SupervisorHandoffContext } from './messageHandoff';

export function createAdjustPlanTool(context: SupervisorHandoffContext, messageOffset = 0) {
  return tool((args, runtime: ToolRuntime) =>
    applySupervisorToolCall(context, messageOffset, runtime, { name: 'adjust_plan', args }), {
    name: 'adjust_plan',
    schema: supervisorControlSchemas.adjust_plan,
    verboseParsingErrors: true,
    description: '调整计划并返回更新后的事实，由你继续决定下一步。',
  });
}
