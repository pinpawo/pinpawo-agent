import { ENTRY_ANSWER_CONTEXT_GUIDANCE, ENTRY_ANSWER_DEFAULT_GUIDANCE, ENTRY_ANSWER_SYSTEM_PROMPT } from './templates/entryAnswer.prompt';

export function buildEntryAnswerSystemPrompt(hasExternalContext = false): string {
  return ENTRY_ANSWER_SYSTEM_PROMPT.render(hasExternalContext ? ENTRY_ANSWER_CONTEXT_GUIDANCE : ENTRY_ANSWER_DEFAULT_GUIDANCE);
}
