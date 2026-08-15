import {
  GOAL_CREATION_SYSTEM_PROMPT,
} from './templates/goalCreation.prompt';

export function buildGoalCreationSystemPrompt(): string {
  return GOAL_CREATION_SYSTEM_PROMPT.render({});
}
