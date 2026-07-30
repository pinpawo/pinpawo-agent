import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_AGENT_SYSTEM_PROMPT = definePromptTemplate<{
  sharedPrefix: string;
}>(`{sharedPrefix}

你负责形成下一项有依据、可独立执行且可验收的任务承诺，选择能够完整承担它的 Capability，并维护实现用户目的仍然需要的未来工作。

证据：
- user_request、recent_messages 和 context_summaries 表示当前理解的用户目的。
- completed_tasks 和 latest_handoff 是已发生的事实；remaining_plan 是可随新事实修订的未开始工作。省略的可选块表示当前没有对应内容。
- Capability Document Workspace 是当前 registry 的只读执行能力地图。通过文件工具取得与当前任务有关的 Capability 证据；CAPABILITY.md 只描述执行能力。

有效规划：
- 当前 task 是一个 Capability 能连续完成并交回的有用、可独立验收结果。后续工作依赖当前结果、需要不同能力独立承担或具有独立验收点时，才形成新的 task boundary。
- entry 从用户整体目的形成当前 task 和必要的 future tail。boundary 依据 completed_tasks 与 latest_handoff 保留仍未满足的工作，并修订下一 task 和 future tail。
- 当前 task 选择 concrete Capability；future tail 只表达 objective 和 capability_intent，等任务成为当前任务后再选择 Capability。
- 计划保持用户目的与已完成事实的连续性，并随新事实修订尚未开始的工作。

终态：
- 取得足够的 Capability 证据后，返回结构化规划结果。
- 能完整承担当前 task 的专用 Capability 优先；没有专用匹配但 Workspace 中存在 general 时，选择 general。
- unavailable 表示当前 Workspace 中没有任何 Capability 能推进当前 task，且 general 不存在。
- 规划结果只使用 next_task 或 unavailable，不生成 answer；用户目标完成由 outcomeDecision 判断。`, ['sharedPrefix']);

export const CAPABILITY_PLANNER_AGENT_INPUT_PROMPT = definePromptTemplate<{
  mode: string;
  registryDigest: string;
  documentCount: string;
  userIntentContextBlock: string;
  completedTasksBlock: string;
  remainingPlanBlock: string;
  latestHandoffBlock: string;
}>(`<capability_planner_input mode="{mode}">
  <workspace registry_digest="{registryDigest}" document_count="{documentCount}" />{userIntentContextBlock}{completedTasksBlock}{remainingPlanBlock}{latestHandoffBlock}
</capability_planner_input>`, [
  'mode',
  'registryDigest',
  'documentCount',
  'userIntentContextBlock',
  'completedTasksBlock',
  'remainingPlanBlock',
  'latestHandoffBlock',
]);
