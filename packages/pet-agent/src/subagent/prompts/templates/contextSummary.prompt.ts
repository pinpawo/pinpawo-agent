export const SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT =
  '较早的执行上下文在接近模型窗口上限时会自动总结；继续工作时以摘要和近期消息为准。';

export const SUBAGENT_CONTEXT_SUMMARY_PREFIX = 'Earlier subagent context summary:';

export const SUBAGENT_CONTEXT_SUMMARY_PROMPT = [
  '请总结下面较早的 subagent 执行上下文，供同一个 subagent 继续完成当前委派任务。',
  '必须保留：当前任务目标、已完成工作、关键发现、明确决策、失败与限制、待完成事项。',
  '文件路径、URL、issue/PR 编号、命令、错误信息和其他证据引用应尽可能保持精确。',
  '工具原始输出只保留影响后续判断的事实，不要逐段复述，不要虚构未出现的信息。',
  '',
  '{messages}',
].join('\n');
