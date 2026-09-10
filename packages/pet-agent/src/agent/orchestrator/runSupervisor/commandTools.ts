import { ToolMessage } from '@langchain/core/messages';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { reviewCurrentSchema, submitPlanSchema, adjustPlanSchema, parseSupervisorCommand } from './protocol';
import { currentSupervisorInput, supervisorCommandContext, type SupervisorInvocationState } from './supervisorState';

export const REVIEW_CURRENT_TOOL_NAME = 'review_current';
export const ADJUST_PLAN_TOOL_NAME = 'adjust_plan';
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
export type SupervisorCommandToolMode = 'entry' | 'boundary';
export const SUPERVISOR_COMMAND_TOOL_NAMES = new Set([
  REVIEW_CURRENT_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, ADJUST_PLAN_TOOL_NAME,
]);
export function supervisorCommandToolNamesForMode(mode: SupervisorCommandToolMode, hasNewUserInput = false): ReadonlySet<string> {
  return mode === 'entry' ? new Set([SUBMIT_PLAN_TOOL_NAME])
    : new Set([REVIEW_CURRENT_TOOL_NAME, ...(hasNewUserInput ? [ADJUST_PLAN_TOOL_NAME] : [])]);
}

/** End this invocation with a typed proposal; only the root applies its effects. */
function propose(name: string, value: unknown, runtime: ToolRuntime<SupervisorInvocationState>) {
  const supervisorCommand = parseSupervisorCommand(value,
    supervisorCommandContext(currentSupervisorInput(runtime.state)));
  return new Command({ update: {
    supervisorCommand,
    messages: [new ToolMessage({ name, tool_call_id: runtime.toolCallId, content: 'Control proposal submitted.' })],
  } });
}

export function createSupervisorCommandTools(mode?: SupervisorCommandToolMode, hasNewUserInput = false): StructuredTool[] {
  const tools = [
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(ADJUST_PLAN_TOOL_NAME,
      { action: 'adjust_plan', ...args }, runtime), {
      name: ADJUST_PLAN_TOOL_NAME, schema: adjustPlanSchema, returnDirect: true,
      description: '用户补充后的 Boundary：按用户明确提出或确认的要求调整目标和完整待执行计划，并决定复用当前 delegation 或新建 delegation。第一项立即执行；不能把替换的旧任务当成完成。用户已经明确要求调整时直接应用，无需重复确认；要求仍不清楚时直接询问。此调用必须独占本次响应。',
    }),
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(SUBMIT_PLAN_TOOL_NAME,
      { action: 'execute_plan', ...args }, runtime), {
      name: SUBMIT_PLAN_TOOL_NAME, schema: submitPlanSchema, returnDirect: true,
      description: 'Entry：提交完整、尽可能短的有序计划，随后调用 delegate_capability 执行第一项。根据 manifest 和已有 Capability 信息安排任务，无需先调用详情工具；已有剩余计划默认沿用，修改须经用户确认。此调用必须独占本次响应，调用后立即返回 root。',
    }),
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(REVIEW_CURRENT_TOOL_NAME,
      { action: 'review_current', ...args }, runtime), {
      name: REVIEW_CURRENT_TOOL_NAME, schema: reviewCurrentSchema, returnDirect: true,
      description: 'Boundary：判断当前 delegation 是否交付。综合当前 delegation 的全部工具执行结果，不能假定最新一次包含所有产出；没有执行证据不得判定完成。completed=true 验收并推进既定计划，false 将 reason 交给同一 delegation 继续完善。当前 task 缺少用户信息或选择，或需要计划变更确认时，直接回复询问用户，不调用本工具；当前 task 已完成但下一项需要用户选择时，可用 completed=true 和 reply 一并验收与提问。此调用必须独占本次响应，调用后立即返回 root。',
    }),
  ];
  return mode ? tools.filter(({ name }) => supervisorCommandToolNamesForMode(mode, hasNewUserInput).has(name)) : tools;
}
