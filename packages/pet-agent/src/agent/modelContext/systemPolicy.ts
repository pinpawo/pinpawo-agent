import { SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import {
  SYSTEM_POLICY_SOURCE,
  SYSTEM_POLICY_TARGET,
  type SystemPolicyRequest,
  type SystemPolicySource,
  type SystemPolicyTarget,
} from '../../types/modelContext';

export {
  SYSTEM_POLICY_SOURCE,
  SYSTEM_POLICY_TARGET,
  type SystemPolicyInstruction,
  type SystemPolicyRequest,
  type SystemPolicySource,
  type SystemPolicyTarget,
} from '../../types/modelContext';

export type SystemPolicyDiagnostics = {
  readonly target: SystemPolicyTarget;
  readonly variant: string | null;
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
const SYSTEM_POLICY_TARGETS = new Set<string>(Object.values(SYSTEM_POLICY_TARGET));

/**
 * Assemble one model call's trusted System Policy.
 *
 * Domain code owns target selection and instruction content. This helper only
 * validates the finite authority boundary, preserves instruction order, and
 * exposes content-free diagnostics. It never reads conversation history or
 * invocation facts.
 */
export function buildSystemPolicy(request: SystemPolicyRequest): SystemPolicy {
  const runtimeTarget = (request as { readonly target: unknown }).target;
  if (typeof runtimeTarget !== 'string' || !SYSTEM_POLICY_TARGETS.has(runtimeTarget)) {
    throw new Error(`Unknown System Policy target: ${String(runtimeTarget)}`);
  }
  if (request.instructions.length === 0) {
    throw new Error(`System Policy "${request.target}" requires at least one instruction.`);
  }
  if (request.variant !== undefined && !request.variant.trim()) {
    throw new Error(`System Policy "${request.target}" variant must be non-empty.`);
  }
  if (request.target === SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER
    && request.variant !== 'entry'
    && request.variant !== 'boundary') {
    throw new Error('Capability Planner System Policy requires entry or boundary variant.');
  }
  if (request.target !== SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER
    && request.variant !== undefined) {
    throw new Error(`System Policy "${runtimeTarget}" does not accept a variant.`);
  }

  const ids = new Set<string>();
  for (const instruction of request.instructions) {
    if (!instruction.id.trim()) {
      throw new Error(`System Policy "${request.target}" instruction id must be non-empty.`);
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
      request.instructions.map(({ content }) => content).join('\n\n'),
    ),
    diagnostics: Object.freeze({
      target: request.target,
      variant: request.variant ?? null,
      instructions: Object.freeze(request.instructions.map((instruction) =>
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
