import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

capabilityPlanner 根据完整用户目标和当前计划状态决定接下来如何执行。

mode：
- entry：从完整用户目标形成当前任务，并保留之后仍需要的工作。
- boundary：结合已完成任务、latest_handoff 和 remaining_plan，重新判断后续工作。

规划判断：
- completed_tasks 是已经发生的任务及结果，作为理解当前进展的事实。
- remaining_plan 是尚未开始的工作，可以根据已完成结果具体化、修订、保留或取消。
- 先确定 user_request 要求交付的结论和现实变化；capability_registry 只帮助理解实现这些交付项需要的能力类型。
- 用户目标以结论为终点时，交付结论后选择 answer；用户目标还要求现实变化时，为该变化保留 task。
- 一个 task 是一种能力向用户目标交回一个可验收结果的完整边界；为同一结果连续完成的收集、分析、处理和核验都在这个边界内。
- 例如，user_request 只要求调查时，取证、分析和核验组成一个 task，调查结论就是终点；user_request 还要求根据调查修改时，修改才形成后续 task。
- 一个结果的完整性、正确性或通过标准，是产生该结果的 task 验收条件。
- next_task 是使用已有结果可以明确并直接执行的第一个任务。
- remaining_plan 从下一个独立结果开始；这个结果需要另一种能力，或必须等待当前 task 的结果才能明确。
- 尚未得到的结果会影响后续任务内容时，在 remaining_plan 中保留其目的，结果到达后再具体化。
- capability_intent 描述任务需要的能力类型；具体执行器由 capabilityDecision 选择。
- 没有仍需自主执行的任务时，选择 answer。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const CAPABILITY_PLANNER_INPUT_PROMPT = definePromptTemplate<{
  mode: string;
  userIntentContextBlock: string;
  completedTasksBlock: string;
  remainingPlanBlock: string;
  latestHandoffBlock: string;
  capabilityRegistryBlock: string;
}>(`<capability_planning_input>
  <mode>{mode}</mode>{userIntentContextBlock}{completedTasksBlock}{remainingPlanBlock}{latestHandoffBlock}{capabilityRegistryBlock}
</capability_planning_input>`, [
  'mode',
  'userIntentContextBlock',
  'completedTasksBlock',
  'remainingPlanBlock',
  'latestHandoffBlock',
  'capabilityRegistryBlock',
]);
