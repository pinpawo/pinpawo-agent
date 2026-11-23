import { indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';

export function buildEntryResolvedGoalContext(goal: string): string {
  return [
    '<run_user_request role="task_boundary" source="entry_answer" trust="read_only">',
    indentXmlBlock(xmlTextBlock('request', goal), 2),
    '</run_user_request>',
  ].join('\n');
}
