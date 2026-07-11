import type { AgentActor } from '../../../types/agent';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import type { RunDelegationSummary } from '../types';
import { clipForPrompt, formatDelegationStatus } from '../utils';
import { buildCapabilityArtifactContext } from './context';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  indentXmlBlock,
  MAX_DECISION_RUN_DELEGATIONS,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  OUTCOME_DECISION_INPUT_PROMPT,
  OUTCOME_DECISION_SYSTEM_PROMPT,
} from './templates/outcomeDecision.prompt';

export function buildDelegationOutcomeCurrentTaskContext(task: {
  id: string;
  lane: string;
  task: string;
  contextSummary: string | null;
} | null): string | null {
  if (!task) return null;
  const lines = [
    '<current_delegation>',
    `  <delegation_id>${task.id}</delegation_id>`,
    `  <lane>${task.lane}</lane>`,
    indentXmlBlock(xmlTextBlock('task', clipForPrompt(task.task, 240)), 2),
  ].filter((line): line is string => Boolean(line));
  if (task.contextSummary) {
    lines.push(indentXmlBlock(xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 320)), 2));
  }
  lines.push('</current_delegation>');
  return lines.join('\n');
}

export function buildDelegationOutcomeOtherTasksContext(
  runDelegationSummaries: RunDelegationSummary[],
  activeDelegationId: string | null,
): string {
  const otherDelegations = activeDelegationId
    ? runDelegationSummaries.filter((delegation) => delegation.id !== activeDelegationId)
    : runDelegationSummaries;
  if (otherDelegations.length === 0) {
    return ['<other_delegations>', '  <none>true</none>', '</other_delegations>'].join('\n');
  }

  const lines = ['<other_delegations>'];
  for (const delegation of otherDelegations.slice(-MAX_DECISION_RUN_DELEGATIONS)) {
    lines.push('  <delegation>');
    lines.push(`    <delegation_id>${delegation.id}</delegation_id>`);
    lines.push(`    <lane>${delegation.lane}</lane>`);
    lines.push(`    <status>${formatDelegationStatus(delegation.status)}</status>`);
    lines.push(indentXmlBlock(xmlTextBlock('task', clipForPrompt(delegation.task, 160)), 4));
    if (delegation.resultPreview) {
      lines.push(indentXmlBlock(xmlTextBlock('result_preview', clipForPrompt(delegation.resultPreview, 220)), 4));
    }
    lines.push('  </delegation>');
  }
  lines.push('</other_delegations>');
  return lines.join('\n');
}

export function buildDelegationOutcomeDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return OUTCOME_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildDelegationOutcomeDecisionInput(params: {
  userIntentContext: string;
  currentTaskContext: string | null;
  subagentAnnounceContext: string | null;
  otherTasksContext?: string | null;
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  return OUTCOME_DECISION_INPUT_PROMPT.render({
    userIntentContextBlock: promptBlock(params.userIntentContext, 2),
    currentDelegationBlock: promptBlock(
      params.currentTaskContext ?? '<current_delegation missing="true" />',
      2,
    ),
    subagentAnnounceBlock: promptBlock(
      params.subagentAnnounceContext ?? '<subagent_announce missing="true" />',
      2,
    ),
    otherDelegationsBlock: promptBlock(params.otherTasksContext, 2),
    capabilityArtifactsBlock: promptBlock(
      artifactContext ? xmlTextBlock('capability_artifacts', artifactContext) : null,
      2,
    ),
  });
}
