import { definePromptTemplate } from '../template';

export const CAPABILITY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前 task 已经确定。capabilityDecision 从 available_executors 中选择能够完成完整 task 并交回所需结果的执行能力。

选择规则：
- 根据 task、context_summary 和每个执行能力的实际描述判断，而不是根据名称或候选身份判断。
- 在能够完成完整 task 的执行能力中，选择职责与 task 最贴合的。
- 执行过程中可以取得的普通细节不构成能力缺失；会改变所需能力的信息不能假定已知。
- 提供的执行能力都不能承担完整 task 时，选择 unavailable。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const CAPABILITY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  taskBlock: string;
  contextSummaryBlock: string;
  availableExecutorsBlock: string;
}>(`<capability_decision_input>{runtimeContextBlock}{taskBlock}{contextSummaryBlock}{availableExecutorsBlock}
</capability_decision_input>`, [
  'runtimeContextBlock',
  'taskBlock',
  'contextSummaryBlock',
  'availableExecutorsBlock',
]);
