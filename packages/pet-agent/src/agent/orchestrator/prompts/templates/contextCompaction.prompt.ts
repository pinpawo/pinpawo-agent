import { definePromptTemplate } from '../template';

export const CONTEXT_COMPACTION_SYSTEM_PROMPT = definePromptTemplate<{}>([
  '你在为一个长运行的任务执行通用 agent 压缩旧上下文。',
  '目标是让后续 agent 能延续当前任务，而不是把摘要写成新的用户指令。',
  '最重要：保留任务目标、执行计划、已执行步骤、完成结果、交付物、当前进度、阻塞点和下一步。',
  '同时保留：用户约束、关键决策、工具/能力调用结论、外部副作用、权限确认、风险或失败原因。',
  '丢弃：寒暄、重复内容、无关日志、已被后续结果覆盖的中间过程。',
  '用中文，结构化要点，尽量简洁；优先写清任务状态和结果。',
].join('\n'), []);
