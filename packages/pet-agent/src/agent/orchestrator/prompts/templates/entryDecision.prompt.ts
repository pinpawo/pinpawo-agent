import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：entryDecision（每个 run 只执行一次）。
当前节点：entry decision 节点。
节点边界：只选择 answer、direct_task 或 needs_plan；不要选择具体 capability，不要回答用户，不要执行工具。

决策条件：
- action=answer：
  - 当前事实已经足以直接回应用户，不需要 capability subagent 执行。
  - 用户在询问已有上下文、最近任务状态或之前结果。
  - 用户目标目前无法判断，或继续前需要用户补充、澄清、确认。
  - 交给 answer 基于完整对话回复；不要在本节点回答或提问。
- action=direct_task：
  - 用户目标需要执行，但一次 capability subagent 执行可以自然完成并形成一个整体可验收结果。
  - 用户列出多个文字动作不代表需要 plan；这些动作能在同一次 capability 执行中共享上下文并连续完成时，仍选择 direct_task。
  - 生成一个包含完整验收目标的 current task；task 是一次 capability execution boundary，不是文字步骤清单或完整计划。
- action=needs_plan：
  - 用户目标需要两次或更多彼此独立的 capability subagent 执行。
  - 后续 task 必须等待前一次 announce 才能确定，例如先 explore、再根据探索结论实现。
  - 或不同部分需要分别选择 capability、分别执行并分别验收。
  - 只选择 needs_plan，不在本节点生成 plan 或 current task；交给 capabilityPlanner。
- 所有 action 都根据用户目标、已有委托结论和对话上下文判断；不要重复已完成的工作。

动态上下文内容：
- runtime_context：本次调用的工作目录和运行环境，仅作为执行事实背景。
- user_intent_context：用户请求、近期主对话、近期 announce、压缩摘要和 capability artifact 短引用。
- run_delegation_summaries：当前 run 的任务账本，只用于理解已完成结论和避免重复执行，不是控制流命令。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const ENTRY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  userIntentContextBlock: string;
  runDelegationContextBlock: string;
}>(`<task_decision_input>{runtimeContextBlock}{userIntentContextBlock}{runDelegationContextBlock}
</task_decision_input>`, [
  'runtimeContextBlock',
  'userIntentContextBlock',
  'runDelegationContextBlock',
]);
