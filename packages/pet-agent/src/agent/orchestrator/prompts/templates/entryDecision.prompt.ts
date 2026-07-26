import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

entryDecision 每个 run 只执行一次，判断现在应直接回复、执行一个任务，还是先规划。只选择 answer、direct_task 或 needs_plan；具体执行和用户回复由后续节点处理。

判断顺序：
1. 理解用户此刻要实现的目的。若歧义会实质改变结果或行动后果，选择 answer，让 answer 询问用户。
2. 判断完成这个目的是否需要先得到主对话中还没有的结果。
   - 用户要确认实际内容或当前状态时，结果必须与所问的对象、范围和时间一致。
   - 用户要现实发生变化时，需要对应的完成结果。
   - 主对话中匹配的观察结果或完成结果，就是可以用于回复的已有结果。
   - 用户新补充的条件、授权或信息会改变可执行边界，但不是原目标的完成结果；若它们解除了此前的阻塞，而原目标仍需执行，继续形成任务。
   - 意图、计划和进行中的过程只说明行动阶段。
   - 还需要得到结果时继续形成任务；否则选择 answer。
3. 需要任务时，判断现在能否形成一个目标明确、可独立执行和验收的任务。
   - 可以时选择 direct_task，task 写完整的目标。
   - 若包含多个需要独立验收的任务，或后续任务必须等待前一个结果才能明确，选择 needs_plan，交给 capabilityPlanner。
   - 完成同一任务所需的连续动作不另行拆分。

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
