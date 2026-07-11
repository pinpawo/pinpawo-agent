import type { AgentActor } from '../../../types/agent';
import { buildDecisionConfig } from './shared';
import { ANSWER_SYSTEM_PROMPT } from './templates/answer.prompt';

export function buildAnswerSystemPrompt(params: {
  actor: AgentActor;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  return ANSWER_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor, params.workdir, params.runtimeEnvironment),
  });
}
