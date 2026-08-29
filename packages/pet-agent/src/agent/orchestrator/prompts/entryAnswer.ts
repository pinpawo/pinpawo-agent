import type { AgentActor } from '../../../types/agent';
import { buildDecisionConfig } from './shared';
import { ENTRY_ANSWER_SYSTEM_PROMPT } from './templates/entryAnswer.prompt';

export function buildEntryAnswerSystemPrompt(params: {
  actor: AgentActor;
}): string {
  return ENTRY_ANSWER_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
  });
}
