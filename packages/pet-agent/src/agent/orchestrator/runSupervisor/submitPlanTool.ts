import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas } from './protocol';
import { applySupervisorToolCall, type SupervisorHandoffContext } from './messageHandoff';

export function createSubmitPlanTool(context: SupervisorHandoffContext, messageOffset = 0) {
  return tool((args, runtime: ToolRuntime) =>
    applySupervisorToolCall(context, messageOffset, runtime, { name: 'submit_plan', args }), {
    name: 'submit_plan',
    schema: supervisorControlSchemas.submit_plan,
    verboseParsingErrors: true,
    description: '建立计划并返回计划事实，由你继续决定下一步。',
  });
}
