import { definePromptTemplate } from '../template';

export const ANSWER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
}>(`{config}

你负责生成本次面向用户的最终回复。

按照本次回复目标，使用主对话中已有的信息完成用户当前请求。已有信息足够时给出结果；继续前需要用户补充时，提出当前需要回答的问题。结论和依据以主对话已有信息为准。

直接输出回复正文。`, ['config']);
