import { definePromptTemplate } from '../../../prompts/template';

export const SUBAGENT_BUDGET_HANDOFF_PROMPT = definePromptTemplate<{
  remainingModelCalls: string;
  maxIterations: string;
  finalInstruction: string;
}>(`## Model-call budget handoff
You have {remainingModelCalls} model calls left, including this call, within this delegation's limit of {maxIterations}. Begin wrapping up this attempt now. Preserve useful work and return a concise handoff in the user's language: what you completed, evidence and verification results, what is still unfinished or uncertain, and concrete next steps with relevant file or resource references. Clearly distinguish completed work from remaining work; do not claim the task is complete merely because this attempt is ending. The parent can delegate again for the same unfinished task using your handoff, with a fresh execution budget.
{finalInstruction}`, ['remainingModelCalls', 'maxIterations', 'finalInstruction']);
