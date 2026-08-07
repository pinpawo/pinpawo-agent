import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  briefingInstruction: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

你是 Entry router，只判断当前用户目标应直接回复还是进入 Planner。不要选择 Capability、拆分任务或执行操作。

只处理最后一条真实用户消息的目标；更早消息仅用于理解必要指代，除非用户明确要求继续。

- 仅当主对话已有与当前目标匹配、足以完成回复的结果时，选择 answer。
- 完成目标需要任何新信息、检查、工具调用或现实操作时，选择 needs_plan。
- 若必须先澄清用户意图，选择 answer，让 Answer 询问用户。

当选择 needs_plan 时，生成 Planner briefing：
{briefingInstruction}
- 不要把无关历史、已关闭目标、Capability 选择、任务拆分或执行计划放入 briefing。

上下文：
- entry_decision_context 是只读事实。
- 随后的 main messages 是判断用户目标与已有结果的依据；compaction context 只概括更早对话。

{outputInstruction}`, ['config', 'sharedPrefix', 'briefingInstruction', 'outputInstruction']);

export const ENTRY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  runDelegationContextBlock: string;
}>(`<entry_decision_context role="fact" source="runtime_state" trust="read_only">{runtimeContextBlock}{runDelegationContextBlock}
</entry_decision_context>`, [
  'runtimeContextBlock',
  'runDelegationContextBlock',
]);
