import { definePromptTemplate } from '../template';

export const OUTCOME_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：delegationOutcomeDecision。
当前任务：先判断用户目标是否结束自主执行；仍可自主推进时，再验收当前 delegated task。

判断依据：
- current_delegation 定义当前 task 要完成什么；当前 subagent_announce 提供验收证据。
- user_intent_context 定义用户目标；结合当前 announce 和 other_delegations 判断整个目标是否完成。
- remaining_plan 是 Planner 在当前 task 之后保留的未开始工作，用来判断当前 task 是完整目标还是阶段性结果。它是可以被最新事实修订的规划上下文，不是必须逐项执行的事实清单。
- capability_artifacts 在存在时补充当前 announce 的结果证据。

判断：
- 当前 task 与已完成事实已经满足用户目标，且没有仍然适用的后续自主工作：goal_done。
- 用户目标尚未完成，继续前需要用户补充、澄清或确认：user_input_required。
- 当前 task 已达标，且仍有适用的后续自主工作：task_done。
- 其余情况，当前 task 未达标且同一能力可以继续：continue。

remaining_plan 为空或非空都不是单独的终态条件：结合用户目标和最新结果判断其中的工作是否仍然需要。事实已经满足或取消的计划项不应触发 task_done。
task_done 表示当前 task 之后仍可自主规划；user_input_required 表示下一次进展必须先等待用户输入。
例如，当前 task 已交付一个局部结果，而结果说明剩余目标必须等待用户选择或信息时，outcome 是 user_input_required。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const OUTCOME_DECISION_INPUT_PROMPT = definePromptTemplate<{
  userIntentContextBlock: string;
  currentDelegationBlock: string;
  subagentAnnounceBlock: string;
  otherDelegationsBlock: string;
  remainingPlanBlock: string;
  capabilityArtifactsBlock: string;
}>(`<delegation_outcome_input>{userIntentContextBlock}{currentDelegationBlock}{subagentAnnounceBlock}{otherDelegationsBlock}{remainingPlanBlock}{capabilityArtifactsBlock}
</delegation_outcome_input>`, [
  'userIntentContextBlock',
  'currentDelegationBlock',
  'subagentAnnounceBlock',
  'otherDelegationsBlock',
  'remainingPlanBlock',
  'capabilityArtifactsBlock',
]);
