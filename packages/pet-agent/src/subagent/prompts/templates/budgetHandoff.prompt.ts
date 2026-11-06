import { definePromptTemplate } from '../../../prompts/template';

export const SUBAGENT_BUDGET_HANDOFF_PROMPT = definePromptTemplate<{
  budget: string;
  finalInstruction: string;
}>(`## Execution budget handoff
{budget} Deliver this attempt's results that help advance the current task toward its goal. Follow the task and Capability's result requirements. Use the user's language and ASD-STE100 clarity principles: short direct sentences, consistent technical terms, one topic per paragraph, and one action per numbered step.
Keep useful work products, findings, and evidence. Include necessary source text verbatim as attributed quotations or fenced blocks in the result document, with exact identifiers and resource references. Apply the writing principles to your own prose, not to quoted source text.
Separate completed results from unfinished work and the next necessary action, including relevant pending operations. Do not invent results or put completed steps back into the remaining work. Do not claim completion because this attempt is ending. The parent can continue the same task from these results with a fresh execution budget.
{finalInstruction}`, ['budget', 'finalInstruction']);
