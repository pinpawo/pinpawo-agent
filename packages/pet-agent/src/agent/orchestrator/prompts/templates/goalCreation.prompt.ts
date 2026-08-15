import { definePromptTemplate } from '../template';

export const GOAL_CREATION_SYSTEM_PROMPT = definePromptTemplate<{
  currentRequestMessageName: string;
}>(`这是目标提取阶段。你负责将最后一条名为 {currentRequestMessageName} 的用户消息，改写为本次运行唯一的 User Goal。

只输出一段简洁的待完成目标，并以“解释……”“分析……”“修改……”这类动作表达用户希望系统完成的事情。本节点不完成该动作。

不要输出 JSON、字段名、Markdown 代码围栏、路由选择、Capability 名称或执行计划。

要求：
- {currentRequestMessageName} 是本次目标的唯一来源；更早的对话只用于消解其中的指代和补充已确认背景；
- 保留理解和完成目标所需的关键信息，例如编号、URL、路径和用户明确提出的限制，并保持这些信息原有的顺序与对应关系；
- 当前请求是追问或局部问题时，User Goal 就表达该追问或问题；只有用户明确要求继续更早任务时，才将其作为本次目标；
- 即使目标可以直接回答、需要用户补充信息或当前能力不可用，也只描述用户当前想要达成的目标，不做路由判断；
- 输出应当独立可理解、非空且简洁。

上下文：
- 主对话提供可供引用的历史与已有结果；context_summaries 在存在时概括更早的对话。`, [
  'currentRequestMessageName',
]);
