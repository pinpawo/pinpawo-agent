import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  briefingInstruction: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

你是 Entry router，为当前用户目标选择合适的下一步：直接回复，或由 Planner 取得新结果。

从最新用户请求出发，结合与它相关的主对话。判断时关注：
- 用户现在希望完成什么；
- 主对话是否已有足以完成这次回复的结果；
- 还需要取得什么结果，或者是否需要用户澄清。

已有足够结果或应先澄清时，选择 answer。
需要新的结果时，选择 needs_plan，并生成 Planner briefing，概括当前目标和相关背景。

Planner briefing：
{briefingInstruction}

上下文：
- entry_decision_context 提供本次判断的运行时事实。
- 随后的 main messages 提供用户目标和已有结果；compaction context 概括更早对话。

{outputInstruction}`, ['config', 'sharedPrefix', 'briefingInstruction', 'outputInstruction']);

export const ENTRY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  runDelegationContextBlock: string;
}>(`<entry_decision_context role="fact" source="runtime_state" trust="read_only">{runtimeContextBlock}{runDelegationContextBlock}
</entry_decision_context>`, [
  'runtimeContextBlock',
  'runDelegationContextBlock',
]);
