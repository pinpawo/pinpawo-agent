import { definePromptTemplate } from '../template';

export const CAPABILITY_PLANNER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
  outputInstruction: string;
}>(`{config}

{sharedPrefix}

当前阶段：capabilityPlanner。
当前节点：capability planning decision 节点。
节点边界：围绕 capability subagent 的独立执行边界维护剩余计划并 materialize 当前 task；不要选择具体 capability id，不要验收 announce，不要回答用户。

规划条件：
- mode=entry：
  - 根据用户目标建立 capability execution boundaries。
  - 将现在可以直接执行的第一个 boundary 输出为 next_task。
  - next_task 之后尚未开始的 boundary 才进入 remaining_plan；依赖未来 handoff 的任务保持 deferred。
- mode=boundary：
  - 根据最新完整 handoff 检查输入 remaining_plan 中尚未开始的任务。
  - 将现在应该执行的 boundary 具体化为 next_task；过时或已由 handoff 满足的任务应取消。
  - next_task 之后仍需保留的未开始任务写入新的 remaining_plan。
- result=next_task：
  - next_task 表示本轮唯一 materialize 的 current task，必须可以直接执行并形成可验收结果。
  - remaining_plan 只包含 next_task 之后尚未开始的 future tail，不要重复 next_task。
- result=answer：
  - 用户目标不再需要自主执行时选择；输出 remaining_plan=[]、next_task=null。
- 所有 mode/result：
  - task 对应一次隔离的 capability execution，不对应用户文字中的普通步骤。
  - 同一次 capability 调用可以自然完成的相关动作不要拆分。
  - capability_intent 描述所需能力类型，不绑定 registry 中的具体 capability id。
  - explore 结果尚未产生时，不编造依赖该结果的实施细节。

{outputInstruction}`, ['config', 'sharedPrefix', 'outputInstruction']);
