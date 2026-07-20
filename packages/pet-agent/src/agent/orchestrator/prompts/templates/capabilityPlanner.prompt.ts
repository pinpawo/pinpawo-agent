import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：capabilityPlanner。
当前任务：根据 mode 确定现在要执行的任务，并更新后续计划。

mode：
- entry：从用户目标开始规划，把第一个现在可执行的任务放入 next_task，之后的任务放入 remaining_plan。
- boundary：根据 latest_handoff 更新 remaining_plan，把现在应执行的任务放入 next_task，保留仍需要的后续任务。

任务规则：
- 同一 capability 可以连续完成的相关动作组成一个任务。
- 依赖未来结果的任务保持 deferred，在结果到达后再具体化。

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
