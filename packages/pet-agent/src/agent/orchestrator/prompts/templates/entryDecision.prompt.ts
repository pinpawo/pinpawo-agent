import { definePromptTemplate } from '../template';

export const ENTRY_DECISION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

entryDecision 每个 run 只执行一次，判断主对话现在能否直接回复，还是要进入可调用工具的执行路径。只选择 answer 或 needs_plan；具体任务边界、执行能力和用户回复由后续节点处理。

needs_plan 的名字不表示一定要拆分多个计划任务。它表示本轮需要由 Capability Planner 选择执行能力，之后可以调用工具取得结果或完成行动。任何工具调用都必须从 needs_plan 路径进入。

当用户当前目标明确时，只有能够明确确认主对话已有证据足以在不执行任何操作的情况下完成回复，才选择 answer；若现有证据是否足够无法明确确认，选择 needs_plan，让 Planner 通过执行和观察补齐结果。

判断顺序：
1. 理解最后一条真实用户消息此刻要实现的目的。更早的用户请求和未完成意图只可用于理解指代；除非最新消息明确要求继续它们，否则不能自动并入当前目标。若歧义会实质改变结果或行动后果，选择 answer，让 answer 询问用户。
2. 判断完成这个目的是否需要先得到主对话中还没有的结果。
   - 用户要确认实际内容或当前状态时，结果必须与所问的对象、范围和时间一致。
   - 检查、确认、比较或汇总当前工作区、远端服务、Issue、PR 等状态，而主对话没有与当前目标匹配的最新观察结果时，选择 needs_plan；很长的历史、旧结论或无关任务不构成这份结果。
   - 用户要现实发生变化时，需要对应的完成结果。
   - 主对话中匹配的观察结果或完成结果，就是可以用于回复的已有结果。
   - 用户新补充的条件、授权或信息会改变可执行边界，但不是原目标的完成结果；若它们解除了此前的阻塞，而原目标仍需执行，继续形成任务。
   - 意图、计划和进行中的过程只说明行动阶段。
   - 如果完成目标需要执行操作或调用工具，选择 needs_plan，交给 capabilityPlanner。
   - needs_plan 表示需要选择能力并进入执行路径，不表示一定有多个任务。不要在这里判断任务如何拆分。

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
