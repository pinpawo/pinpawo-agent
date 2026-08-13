import { definePromptTemplate } from '../template';

export const GOAL_CREATION_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
  sharedPrefix: string;
}>(`{config}

{sharedPrefix}

你负责根据最新用户请求和相关主对话，创建本次任务唯一、稳定的 User Goal。

直接输出目标文本本身，不要输出 JSON、字段名、Markdown 代码围栏、路由选择、Capability 名称或执行计划。

要求：
- 保留理解和完成目标所需的关键信息，例如编号、URL、路径和用户明确提出的限制，并保持这些信息原有的顺序与对应关系；
- 消解理解当前目标所必需的指代，并自然带入完成目标所需的已确认背景；
- 排除无关历史、已关闭目标、内部 Planner 内容和未经确认的推断；
- 即使目标可以直接回答、需要用户补充信息或当前能力不可用，也只描述用户当前想要达成的目标，不做路由判断；
- 输出应当独立可理解、非空且简洁。

上下文：
- goal_creation_context 提供本次运行时事实；
- 随后的用户与助手消息提供用户目标和已有结果；context_summaries 在存在时概括更早的对话。`, [
  'config',
  'sharedPrefix',
]);

export const GOAL_CREATION_INPUT_PROMPT = definePromptTemplate<{
  runtimeContextBlock: string;
  runDelegationContextBlock: string;
}>(`<goal_creation_context role="fact" source="runtime_state" trust="read_only">{runtimeContextBlock}{runDelegationContextBlock}
</goal_creation_context>`, [
  'runtimeContextBlock',
  'runDelegationContextBlock',
]);
