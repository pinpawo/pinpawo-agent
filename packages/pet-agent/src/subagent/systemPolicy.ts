import { SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import {
  SYSTEM_POLICY_SOURCE,
  type SystemPolicyInstruction,
  type SystemPolicySource,
} from '../types/modelContext';

export {
  SYSTEM_POLICY_SOURCE,
  type SystemPolicyInstruction,
  type SystemPolicySource,
} from '../types/modelContext';

export type SystemPolicyDiagnostics = {
  readonly instructions: ReadonlyArray<{
    readonly id: string;
    readonly source: SystemPolicySource;
    readonly owner: string | null;
    readonly digest: string;
  }>;
};

export type SystemPolicy = {
  readonly message: SystemMessage;
  readonly diagnostics: SystemPolicyDiagnostics;
};

const SYSTEM_POLICY_SOURCES = new Set<string>(Object.values(SYSTEM_POLICY_SOURCE));

/**
 * Compose registered Capability and Toolkit instructions into one System Policy.
 *
 * Ordinary node prompts use their domain template directly. This helper exists
 * only for the subagent boundary where multiple registered instruction owners
 * genuinely need composition and content-free diagnostics.
 */
export function composeCapabilitySystemPolicy(
  instructions: readonly SystemPolicyInstruction[],
): SystemPolicy {
  if (instructions.length === 0) {
    throw new Error('System Policy requires at least one instruction.');
  }
  const ids = new Set<string>();
  for (const instruction of instructions) {
    if (!instruction.id.trim()) {
      throw new Error('System Policy instruction id must be non-empty.');
    }
    if (ids.has(instruction.id)) {
      throw new Error(`Duplicate System Policy instruction id: ${instruction.id}`);
    }
    ids.add(instruction.id);
    if (!SYSTEM_POLICY_SOURCES.has(instruction.source)) {
      throw new Error(`Unknown System Policy instruction source: ${instruction.source}`);
    }
    if (!instruction.content.trim()) {
      throw new Error(`System Policy instruction "${instruction.id}" content must be non-empty.`);
    }
    if (instruction.owner !== undefined && !instruction.owner.trim()) {
      throw new Error(`System Policy instruction "${instruction.id}" owner must be non-empty.`);
    }
  }

  return Object.freeze({
    message: new SystemMessage(
      instructions.map(({ content }) => content).join('\n\n'),
    ),
    diagnostics: Object.freeze({
      instructions: Object.freeze(instructions.map((instruction) =>
        Object.freeze({
          id: instruction.id,
          source: instruction.source,
          owner: instruction.owner ?? null,
          digest: createHash('sha256')
            .update(instruction.content, 'utf8')
            .digest('hex'),
        }))),
    }),
  });
}
