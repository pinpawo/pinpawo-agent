import { SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT } from './templates/contextSummary.prompt';
import type { CapabilitySystemPromptVars } from './templates/capability.prompt';

export type CapabilitySystemPromptInput = {
  contextSummaryEnabled: boolean;
  toolkitInstructions: readonly string[];
  capabilityInstruction: string;
};

function optionalInstructionBlock(instructions: readonly string[]): string {
  const content = instructions
    .filter((instruction) => Boolean(instruction.trim()))
    .join('\n\n');
  return content ? `\n\n${content}` : '';
}

export function deriveCapabilitySystemPromptVars(
  input: CapabilitySystemPromptInput,
): CapabilitySystemPromptVars {
  if (!input.capabilityInstruction.trim()) {
    throw new Error('Capability System Prompt requires a Capability instruction.');
  }

  return {
    contextSummaryInstruction: input.contextSummaryEnabled
      ? `\n\n${SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT}`
      : '',
    toolkitInstructions: optionalInstructionBlock(input.toolkitInstructions),
    capabilityInstruction: `\n\n${input.capabilityInstruction}`,
  };
}
