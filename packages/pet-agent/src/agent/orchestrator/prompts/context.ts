import type { UserRequest } from '../types';
import { indentXmlBlock, xmlTextBlock } from './shared';

export function buildRunUserRequestContext(userRequest: UserRequest | null): string {
  if (!userRequest) return '<run_user_request missing="true" />';
  return [
    '<run_user_request role="task_boundary" source="orchestrator_state" trust="read_only">',
    indentXmlBlock(xmlTextBlock('request', userRequest), 2),
    '</run_user_request>',
  ].join('\n');
}
