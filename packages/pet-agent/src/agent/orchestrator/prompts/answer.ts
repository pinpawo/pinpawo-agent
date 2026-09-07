import { ENTRY_ANSWER_SYSTEM_PROMPT } from './templates/entryAnswer.prompt';

export function buildEntryAnswerSystemPrompt(): string {
  return ENTRY_ANSWER_SYSTEM_PROMPT.render({});
}
