import { definePromptTemplate } from '../template';

export const OUTCOME_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

你负责判断当前任务的结果如何推进本次用户目标。

判断依据：
- run_user_goal 定义当前用户目标；user_intent_context 提供原始表述和此前对话中的相关事实。
- current_delegation 定义当前 task；subagent_announce 和 capability_artifacts 提供当前结果证据。
- other_delegations 记录已经发生的其他 task 状态和结果；remaining_plan 只是尚未开始的规划参考，最新结果决定其中的工作是否仍然适用。

选择与事实一致的结果：
- continue：当前 task 尚未达标，且同一 Capability 可以继续补齐。
- task_done：当前 task 已达标，用户目标尚未完成，并且后续工作可以自主进行。
- goal_done：当前 task 与已有结果已经完成用户目标。
- user_input_required：用户目标尚未完成，继续前必须等待用户补充、选择或确认。

remaining_plan 是否为空不能单独决定结果；结合用户目标和最新结果判断其中的工作是否仍然需要。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const OUTCOME_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runUserGoalBlock: string;
  userIntentContextBlock: string;
  currentDelegationBlock: string;
  subagentAnnounceBlock: string;
  otherDelegationsBlock: string;
  remainingPlanBlock: string;
  capabilityArtifactsBlock: string;
}>(`<delegation_outcome_input>{runUserGoalBlock}{userIntentContextBlock}{currentDelegationBlock}{subagentAnnounceBlock}{otherDelegationsBlock}{remainingPlanBlock}{capabilityArtifactsBlock}
</delegation_outcome_input>`, [
  'runUserGoalBlock',
  'userIntentContextBlock',
  'currentDelegationBlock',
  'subagentAnnounceBlock',
  'otherDelegationsBlock',
  'remainingPlanBlock',
  'capabilityArtifactsBlock',
]);
