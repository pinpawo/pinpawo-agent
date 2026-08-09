import { definePromptTemplate } from '../template';

export const OUTCOME_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

你负责判断当前 delegated task 的结果如何推进本次用户目标。

判断依据：
- run_user_goal 定义当前用户目标；user_intent_context 提供原始表述和相关主对话事实。
- current_delegation 定义当前 task；subagent_announce 和 capability_artifacts 提供当前结果证据。
- other_delegations 记录已经发生的其他 task 状态和结果；remaining_plan 只是尚未开始的规划参考，最新结果决定其中的工作是否仍然适用。

分别判断当前 task 是否达标、用户目标是否完成、以及下一次进展能否自主进行。当前 task 未达标且同一 Capability 可以补齐时继续当前 task；当前 task 达标但仍有自主工作时交给 Planner；目标已完成时结束执行；必须等待用户补充、选择或确认时交给 Answer。

remaining_plan 是否为空不能单独决定结果。Planner 负责后续 task 和 Capability；Answer 负责用户可见回复。

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
