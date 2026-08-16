import type {
  SubagentAnnounce,
  SubagentCompletionReason,
  UserGoal,
} from '../types';
import { clipForPrompt } from '../utils';
import { indentXmlBlock, xmlTextBlock } from './shared';

export function buildRunUserGoalContext(userGoal: UserGoal | null): string {
  if (!userGoal) return '<run_user_goal missing="true" />';
  return [
    '<run_user_goal role="task_boundary" source="orchestrator_state" trust="read_only">',
    indentXmlBlock(xmlTextBlock('goal', userGoal), 2),
    '</run_user_goal>',
  ].join('\n');
}

function formatSubagentAnnounceArtifactRefs(item: SubagentAnnounce): string | null {
  if (!item.artifactRefs || item.artifactRefs.length === 0) return null;
  const lines = ['  <artifacts>'];
  for (const ref of item.artifactRefs) {
    lines.push('    <artifact>');
    lines.push(`      <uri>${clipForPrompt(ref.uri, 260)}</uri>`);
    lines.push(`      <capability>${clipForPrompt(ref.capabilityId, 120)}</capability>`);
    lines.push(`      <kind>${ref.kind}</kind>`);
    if (ref.title) lines.push(`      <title>${clipForPrompt(ref.title, 140)}</title>`);
    if (ref.preview) lines.push(indentXmlBlock(xmlTextBlock('preview', clipForPrompt(ref.preview, 180)), 6));
    lines.push('    </artifact>');
  }
  lines.push('  </artifacts>');
  return lines.join('\n');
}

export function buildSubagentAnnounceContext(
  item: SubagentAnnounce | null,
  completionReason?: SubagentCompletionReason | null,
): string | null {
  if (!item) return null;
  // Do not pre-classify the announce: the private Planner owns completion judgment.
  const resultBlock = item.text
    ? xmlTextBlock('result', item.text.trim(), ' format="markdown" role="data"')
    : null;
  return [
    '<subagent_announce>',
    item.delegationId ? `  <delegation_id>${item.delegationId}</delegation_id>` : null,
    `  <lane>${item.lane}</lane>`,
    completionReason ? `  <stop_reason>${completionReason}</stop_reason>` : null,
    resultBlock ? indentXmlBlock(resultBlock, 2) : null,
    formatSubagentAnnounceArtifactRefs(item),
    '</subagent_announce>',
  ].filter(Boolean).join('\n');
}
