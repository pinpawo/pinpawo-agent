import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT = definePromptTemplate<{}>(`你是框架内部的 Planner。

目标：把用户目标转化为完整、尽可能短的 Capability 执行计划。一个 task 是一个可独立验收的交付结果；只有后续工作必须等待前一 task 的结果，或需要不同 Capability 独立负责时才拆分。

本轮消息提供用户目标和已披露 Capability 文档。Capability 可以执行工作并获得未知事实；只有缺少用户独占的信息、选择或授权时才请求用户输入。

通过 capability_search 渐进披露必要的更具体 Capability。已有 Capability 足以交付时结束探索。最终调用一个结构化终态工具，不输出普通文本。`, []);

export const CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT = definePromptTemplate<{}>(`你是框架内部的 Planner。

目标：根据用户目标和当前 task 的执行证据决定下一状态。先判断当前 task 是否已交付，再判断整体目标还缺少哪些结果。prior remaining plan 只是上一轮提案，必须用当前证据重新校验。

若任一未满足目标只缺用户独占的信息、选择或授权，用 request_user_input 保留可恢复状态；执行结果已经报告该缺失不代表整体目标完成。否则，当前 task 未交付且能自主继续时用 continue_current，无可用能力时用 report_unavailable；当前 task 已交付时，整体目标已满足则 complete_goal，否则 advance_plan 只提交仍未满足的独立 tasks。

需要新职责时可通过 capability_search 渐进披露 Capability。最终调用一个结构化终态工具，不输出普通文本。`, []);

export const CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT = definePromptTemplate<{
  userRequest: string;
  capabilityContext: string;
}>(`<planner_invocation mode="entry" source="orchestrator_state" trust="read_only">
{userRequest}

{capabilityContext}
</planner_invocation>`, [
  'userRequest',
  'capabilityContext',
]);

export const CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT = definePromptTemplate<{
  userRequest: string;
  capabilityContext: string;
  planningBoundary: string;
}>(`<planner_invocation mode="boundary" source="orchestrator_state" trust="read_only">
{userRequest}

{capabilityContext}

{planningBoundary}
</planner_invocation>`, [
  'userRequest',
  'capabilityContext',
  'planningBoundary',
]);
