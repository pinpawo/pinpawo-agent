import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  userGoalInstruction: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

你负责判断当前用户请求应该直接回复，还是需要先制定执行计划。

从最新用户请求出发，结合与它相关的主对话：
1. 当前仍缺少完成请求必需的目标、范围或选择，或当前表述无法理解时，选择 answer 向用户询问；在用户补充前，本次任务暂不开始执行。
2. 信息足够后，如完成当前用户请求需要调用任何工具，选择 needs_plan；否则选择 answer。

选择 needs_plan 时生成本次执行目标，概括当前目标和相关背景。

本次执行目标：
{userGoalInstruction}

上下文：
- entry_decision_context 提供本次判断的运行时事实。
- 随后的用户与助手消息提供用户目标和已有结果；context_summaries 在存在时概括更早的对话。

{outputInstruction}`, ['config', 'sharedPrefix', 'userGoalInstruction', 'outputInstruction']);

export const ENTRY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  runDelegationContextBlock: string;
}>(`<entry_decision_context role="fact" source="runtime_state" trust="read_only">{runtimeContextBlock}{runDelegationContextBlock}
</entry_decision_context>`, [
  'runtimeContextBlock',
  'runDelegationContextBlock',
]);
