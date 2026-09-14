import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas } from './protocol';
import { applySupervisorToolCall, type SupervisorHandoffContext } from './messageHandoff';

export function createReviewCurrentTool(context: SupervisorHandoffContext, messageOffset = 0) {
  return tool((args, runtime: ToolRuntime) =>
    applySupervisorToolCall(context, messageOffset, runtime, { name: 'review_current', args }), {
    name: 'review_current',
    schema: supervisorControlSchemas.review_current,
    verboseParsingErrors: true,
    description: '验收当前交付并记录结论。返回计划事实，不触发执行；之后由你决定执行、调整或直接回复。',
  });
}
