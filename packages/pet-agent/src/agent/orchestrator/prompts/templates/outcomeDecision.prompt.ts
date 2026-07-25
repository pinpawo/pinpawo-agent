import { definePromptTemplate } from '../template';

export const OUTCOME_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：delegationOutcomeDecision。
当前任务：验收当前 delegated task，并判断是否还需要自主执行。

判断依据：
- current_delegation 定义当前 task 要完成什么；当前 subagent_announce 提供验收证据。
- user_intent_context 定义用户目标；结合当前 announce 和 other_delegations 判断整个目标是否完成。
- capability_artifacts 在存在时补充当前 announce 的结果证据。
- stop_reason=cancelled 表示工具调用被用户取消，不表示 task 已完成。若同一 capability 能按取消说明调整执行，选择 continue；若必须等待用户补充或确认，选择 await_user。

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
