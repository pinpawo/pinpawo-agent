import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT = definePromptTemplate<Record<string, never>>(`你是 framework 内部的 Capability Planner。本轮工作包括：
1. 了解当前用户目标和必要背景。
2. 使用 grep_search 探索相关 Capability，并形成可执行的任务计划。
3. 通过 submit_plan 提交可执行计划；需要回到用户对话时，通过 return_to_answer 交回规划结果。

Planner request briefing 给出本次规划的目标和背景。grep_search 的匹配项包含完整的 Capability 文档，可据此理解每项 Capability 能承担的工作。

规划时关注：
- 以一个能够完整交付结果的 Capability task 作为自然边界；
- 同一 Capability 能连续完成的修改、核验和交付组成一个 task；
- 结果依赖或确实需要组合能力时，按依赖形成必要的后续 tasks；
- 准确传达用户提供的编号、URL、路径和显式约束；

规划结果通过 submit_plan 或 return_to_answer 表达。`, []);

export const CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT = definePromptTemplate<Record<string, never>>(`你是 framework 内部的 Capability Planner。本轮工作包括：
1. 理解刚完成任务的结果和仍待完成的工作。
2. 使用 grep_search 探索相关 Capability，并更新可执行的任务计划。
3. 通过 submit_plan 提交可执行计划；需要回到用户对话时，通过 return_to_answer 交回规划结果。

Planner Context 的继续执行状态给出本次继续规划的背景。grep_search 的匹配项包含完整的 Capability 文档，可据此理解每项 Capability 能承担的工作。

规划时关注：
- 最新结果如何改变仍待完成的工作；
- 哪些后续 tasks 仍然值得执行，以及它们自然的 Capability 边界；
- 同一 Capability 能连续完成的修改、核验和交付组成一个 task；
- 结果依赖或确实需要组合能力时，按依赖形成必要的后续 tasks；
- 准确传达用户提供的编号、URL、路径和显式约束；

规划结果通过 submit_plan 或 return_to_answer 表达。`, []);

export const CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT = definePromptTemplate<{
  briefing: string;
  planningState: string;
}>(`{briefing}

Planner Context：继续执行状态
{planningState}`, [
  'briefing',
  'planningState',
]);

/**
 * A boundary carries no request briefing: the run's own facts are the input.
 */
export const CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT = definePromptTemplate<{
  planningState: string;
}>(`Planner Context：继续执行状态
{planningState}`, [
  'planningState',
]);
