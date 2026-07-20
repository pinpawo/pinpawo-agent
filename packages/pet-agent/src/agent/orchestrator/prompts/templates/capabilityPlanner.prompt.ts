import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：capabilityPlanner。
当前任务：根据 mode 和已有结果，确定本轮的 next_task，并维护之后的 remaining_plan。

mode：
- entry：从用户目标开始规划，把第一个现在可执行的任务放入 next_task，之后的任务放入 remaining_plan。
- boundary：根据 latest_handoff 更新 remaining_plan，把现在应执行的任务放入 next_task，保留仍需要的后续任务。

result：
- next_task：
  - next_task 是本轮唯一的当前任务，应当可以直接执行并得到可验收结果。
  - remaining_plan 只包含 next_task 之后尚未开始的任务。
- answer：没有后续执行；remaining_plan 为空，next_task 为空。

任务规则：
- 同一 capability 可以连续完成的相关动作组成一个任务。
- 依赖未来结果的任务保持 deferred，在结果到达后再具体化。
- capability_intent 概括任务需要的能力类型；具体执行器由 capabilityDecision 选择。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const CAPABILITY_PLANNER_INPUT_PROMPT = definePromptTemplate<{
  mode: string;
  userIntentContextBlock: string;
  remainingPlanBlock: string;
  latestHandoffBlock: string;
  capabilityRegistryBlock: string;
}>(`<capability_planning_input>
  <mode>{mode}</mode>{userIntentContextBlock}{remainingPlanBlock}{latestHandoffBlock}{capabilityRegistryBlock}
</capability_planning_input>`, [
  'mode',
  'userIntentContextBlock',
  'remainingPlanBlock',
  'latestHandoffBlock',
  'capabilityRegistryBlock',
]);
