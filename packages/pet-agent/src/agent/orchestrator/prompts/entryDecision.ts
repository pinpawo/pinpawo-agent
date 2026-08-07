import type { AgentActor } from '../../../types/agent';
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

export function buildEntryDecisionSystemPrompt(params: {
  actor: AgentActor;
  briefingInstruction?: string;
  outputInstruction: string;
}): string {
  return ENTRY_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    briefingInstruction: params.briefingInstruction
      ?? buildJsonEntryDecisionBriefingInstruction(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildJsonEntryDecisionBriefingInstruction(): string {
  return [
    '- planner_objective：当前真实用户目标的准确、可执行摘要。保留编号、URL、路径、先后顺序和显式限制；消解理解目标所必需的指代。',
    '- planner_context：仅保留理解该目标所需的已确认背景、约束或事实；没有则为 null。',
    '- 当选择 answer 时，planner_objective 和 planner_context 均为 null。',
  ].join('\n');
}

export function buildEntryDecisionInput(params: {
  runDelegationContext?: string | null;
  runtimeContext?: string | null;
}): string {
  return ENTRY_DECISION_INPUT_PROMPT.render({
    runtimeContextBlock: promptBlock(params.runtimeContext, 2),
    runDelegationContextBlock: promptBlock(params.runDelegationContext
      ? xmlTextBlock('run_delegation_summaries', params.runDelegationContext, ' role="fact" source="state"')
      : null, 2),
  });
}
