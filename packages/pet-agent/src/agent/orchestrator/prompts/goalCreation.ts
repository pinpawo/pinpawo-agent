import type { BaseMessage } from '@langchain/core/messages';
import { xmlTextBlock } from './shared';
import {
  GOAL_CREATION_SYSTEM_PROMPT,
} from './templates/goalCreation.prompt';

export const GOAL_CREATION_CURRENT_REQUEST_MESSAGE_NAME =
  'goal_creation_current_request';

export function buildGoalCreationCurrentRequestContent(
  content: BaseMessage['content'],
): BaseMessage['content'] {
  const attributes = ' role="task_boundary" source="latest_human_message"';
  if (typeof content === 'string') {
    return xmlTextBlock('current_request', content, attributes);
  }
  return [
    {
      type: 'text',
      text: `<current_request${attributes}>`,
    },
    ...content,
    {
      type: 'text',
      text: '</current_request>',
    },
  ];
}

export function buildGoalCreationSystemPrompt(): string {
  return GOAL_CREATION_SYSTEM_PROMPT.render({
    currentRequestMessageName: GOAL_CREATION_CURRENT_REQUEST_MESSAGE_NAME,
  });
}
