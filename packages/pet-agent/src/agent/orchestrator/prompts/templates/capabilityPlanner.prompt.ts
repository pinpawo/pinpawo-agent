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
- 一个 task 延续到同一种能力交回一个对用户目标有用的结果；该能力在过程中自行安排的阶段属于这个 task。
- next_task 是使用已有结果可以明确并直接执行的第一个任务。
- 后续工作必须等待前一 task 的结果才能决定，或需要另一种能力执行时，形成新的 task。
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
