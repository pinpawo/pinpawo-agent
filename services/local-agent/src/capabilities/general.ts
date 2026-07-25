import {
  defineCapability,
  defineInstructionDocument,
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
} from '@pinpawo/pet-agent';

const GENERAL_CAPABILITY_INSTRUCTIONS = `
# General

Use the available Toolkit tools to complete the delegated task.

- Prefer tools when they can verify facts or perform the requested work.
- Stay within the delegated task and return a concise, concrete result.
- Do not claim an action succeeded unless a tool result confirms it.
`;

export function createGeneralCapability(
  uses: readonly string[],
): AgentCapability {
  return defineCapability({
    name: GENERAL_CAPABILITY_NAME,
    description: 'Handle general tasks that do not require a more specific Capability.',
    uses: [...uses],
    instructions: defineInstructionDocument({
      content: GENERAL_CAPABILITY_INSTRUCTIONS,
    }),
  });
}
