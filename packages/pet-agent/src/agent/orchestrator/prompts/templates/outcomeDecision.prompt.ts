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
- capability_artifacts 在存在时补充当前 announce 的结果证据。

判断：
- 用户目标已经完成：goal_done。
- 用户目标尚未完成，继续前需要用户补充、澄清或确认：user_input_required。
- 其余情况，当前 task 已达标：task_done。
- 其余情况，当前 task 未达标且同一能力可以继续：continue。

task_done 表示当前 task 之后仍可自主规划；user_input_required 表示下一次进展必须先等待用户输入。
例如，当前 task 已交付一个局部结果，而结果说明剩余目标必须等待用户选择或信息时，outcome 是 user_input_required。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const OUTCOME_DECISION_INPUT_PROMPT = definePromptTemplate<{
  userIntentContextBlock: string;
  currentDelegationBlock: string;
  subagentAnnounceBlock: string;
  otherDelegationsBlock: string;
  capabilityArtifactsBlock: string;
}>(`<delegation_outcome_input>{userIntentContextBlock}{currentDelegationBlock}{subagentAnnounceBlock}{otherDelegationsBlock}{capabilityArtifactsBlock}
</delegation_outcome_input>`, [
  'userIntentContextBlock',
  'currentDelegationBlock',
  'subagentAnnounceBlock',
  'otherDelegationsBlock',
  'capabilityArtifactsBlock',
]);
