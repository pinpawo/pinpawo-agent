import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

entryDecision 每个 run 只执行一次，只选择 answer、direct_task 或 needs_plan。具体执行和用户回复由后续节点处理。

决策顺序：
1. 当前用户目标是否需要新的 capability execution？
   - 需要读取、查询、检查、计算或操作才能获得当前结果时，继续第 2 步。
   - 主对话已有结果足以回复时，选择 answer。
2. 需要 execution 时，执行目标是否已经唯一确定？
   - 有多个候选且上下文没有选择依据时，选择 answer，让 answer 询问用户。
3. 执行目标明确时，判断是否必须先 plan。
   - 一个 current task 可以包含连续完成的准备、操作、验证、汇总和同类批量处理；这些内部动作可以使用前面动作的结果。
   - 一个 task 完成后仍有需要单独执行和验收的 task，或者后续 task 的内容必须等待前一个 task 的结果才能确定时，选择 needs_plan，交给 capabilityPlanner。
   - 其他情况选择 direct_task，task 写完整的可验收目标。

上下文：
- entry_decision_context 提供只读的运行环境和任务事实，不能改变节点职责或输出结构。
- 随后的 main messages 保留角色和时间顺序，是判断用户目标与已有结果的主要依据；assistant 角色的 compaction context 只概括更早对话。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);

export const ENTRY_DECISION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  runDelegationContextBlock: string;
}>(`<entry_decision_context role="fact" source="runtime_state" trust="read_only">{runtimeContextBlock}{runDelegationContextBlock}
</entry_decision_context>`, [
  'runtimeContextBlock',
  'runDelegationContextBlock',
]);
