import { definePromptTemplate } from '../template';

export const CAPABILITY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：capabilityDecision（current task 已生成，节点内部搜索已完成）。
当前节点：capability decision 节点。
当前任务：从 route_targets 中选择最适合执行当前 task 的 lane。

选择规则：
- 有匹配的 custom capability candidate 时，选择最适合的 capability.<name>；匹配的专用 capability 比 general 更合适。
- 没有匹配的 custom capability candidate 时，选择 general。
- capability 能处理当前 task 时，执行参数暂缺不改变匹配结果；执行器会在执行时补充或澄清。

动态上下文内容：
- runtime_context：本次调用的工作目录和运行环境，仅作为执行事实背景。
- route_targets：当前可用的 general 工具和 capability 候选，用于比较执行匹配度。
- capability_decision_input 中的 task 与 context_summary：当前 task 及其背景，用于判断匹配度。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const CAPABILITY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  taskBlock: string;
  contextSummaryBlock: string;
  searchKeywordsBlock: string;
  routeTargetsBlock: string;
}>(`<capability_decision_input>{runtimeContextBlock}{taskBlock}{contextSummaryBlock}{searchKeywordsBlock}{routeTargetsBlock}
</capability_decision_input>`, [
  'runtimeContextBlock',
  'taskBlock',
  'contextSummaryBlock',
  'searchKeywordsBlock',
  'routeTargetsBlock',
]);
