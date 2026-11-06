import { definePromptTemplate } from '../../../prompts/template';

export const SUBAGENT_BUDGET_HANDOFF_PROMPT = definePromptTemplate<{
  budget: string;
  finalInstruction: string;
}>(`## Execution budget handoff
{budget}
Deliver this attempt's useful results and evidence for the current task. Follow the task and Capability's result requirements. Use short, direct sentences and consistent terms in the user's language (ASD-STE100 clarity principles).
Preserve necessary source text verbatim as attributed quotations, with exact identifiers and resource references. State completed results, remaining work and the next necessary action, including pending operations. The parent can continue the same task from these results with a fresh budget. Ending this attempt does not mean the task is complete.
{finalInstruction}`, ['budget', 'finalInstruction']);
