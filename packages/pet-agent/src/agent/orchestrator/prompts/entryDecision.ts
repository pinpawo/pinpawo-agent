import type { CapabilityArtifactRef } from '../../../types/artifact';
import type { AgentActor } from '../../../types/agent';
import { buildCapabilityArtifactContext } from './context';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  ENTRY_DECISION_INPUT_PROMPT,
  ENTRY_DECISION_SYSTEM_PROMPT,
} from './templates/entryDecision.prompt';

export function buildTaskDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return ENTRY_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildTaskDecisionInput(params: {
  capabilityArtifacts?: CapabilityArtifactRef[];
  runDelegationContext?: string | null;
  runtimeContext?: string | null;
}): string {
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  return ENTRY_DECISION_INPUT_PROMPT.render({
    runtimeContextBlock: promptBlock(params.runtimeContext, 2),
    capabilityArtifactsBlock: promptBlock(artifactContext
      ? xmlTextBlock('capability_artifacts', artifactContext, ' role="fact" source="state"')
      : null, 2),
    runDelegationContextBlock: promptBlock(params.runDelegationContext
      ? xmlTextBlock('run_delegation_summaries', params.runDelegationContext, ' role="fact" source="state"')
      : null, 2),
  });
}
