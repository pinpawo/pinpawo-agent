import { definePromptTemplate } from '../template';

export const ANSWER_SYSTEM_PROMPT = definePromptTemplate<{
  config: string;
}>(`{config}

你负责生成本次面向用户的最终回复。

按照本次回复目标，根据主对话中已有的信息生成回复。结论和依据以这些信息为准。

直接输出回复正文。`, ['config']);
