import type { BaseMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import type { AgentActor, AgentExecution, AgentModels } from './agent';
import type { SubagentResult } from './subagent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from './artifact';

export type InstructionDocumentSource =
  | {
      readonly kind: 'file';
      readonly path: string;
    }
  | {
      readonly kind: 'inline';
      readonly id: string;
    };

export type InstructionDocument = {
  readonly content: string;
  readonly source: InstructionDocumentSource;
  readonly digest: string;
};

export type CapabilityFinalizeContext = {
  models: AgentModels;
  actor: AgentActor;
  /** Read-only capability-lane history captured before this subagent run. */
  messages: readonly BaseMessage[];
  execution?: AgentExecution;
  artifactStore?: CapabilityArtifactStore;
  recordCapabilityArtifact?: (ref: CapabilityArtifactRef) => void | Promise<void>;
  threadId?: string | null;
  capabilityId: string;
  delegationId: string;
  runId: string;
};

export type CapabilityFinalizeResult = {
  messages?: BaseMessage[];
  announceMessageId?: string | null;
  artifactRefs?: CapabilityArtifactRef[];
};

export type CapabilityFinalizeHook = (
  result: Readonly<SubagentResult>,
  context: CapabilityFinalizeContext,
) => CapabilityFinalizeResult | void | Promise<CapabilityFinalizeResult | void>;

export type CapabilityLifecycle = {
  finalize?: CapabilityFinalizeHook;
};

export type CapabilityAvailability = {
  available: boolean;
  reason?: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type AgentCapability = {
  readonly name: string;
  readonly description: string;
  /**
   * Required Toolkit dependencies and the complete tool permission boundary
   * for this Capability.
   */
  uses: readonly string[];
  instructions: InstructionDocument;
  readonly lifecycle?: CapabilityLifecycle;
};

const validatedInstructionDocuments = new WeakMap<
  object,
  { content: string; digest: string }
>();

export function defineInstructionDocument(params: {
  content: string;
  source: InstructionDocumentSource;
}): InstructionDocument {
  const content = params.content.trim();
  if (!content) {
    throw new Error('Capability instructions must be a non-empty Markdown document');
  }
  const sourceValue = params.source.kind === 'file'
    ? params.source.path
    : params.source.id;
  if (!sourceValue.trim()) {
    throw new Error(`Capability instruction ${params.source.kind} source must be non-empty`);
  }
  return {
    content,
    source: params.source,
    digest: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export function defineCapability(capability: AgentCapability): AgentCapability {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new Error('Capability definition must be an object');
  }
  if (typeof capability.name !== 'string' || !capability.name.trim()) {
    throw new Error('Capability name must be non-empty');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(capability.name)) {
    throw new Error(
      `Capability name "${capability.name}" must use lowercase letters, numbers, "_" or "-"`,
    );
  }
  if (typeof capability.description !== 'string' || !capability.description.trim()) {
    throw new Error(`Capability "${capability.name}" description must be non-empty`);
  }
  if (
    !Array.isArray(capability.uses)
    || capability.uses.some((name) => typeof name !== 'string' || !name.trim())
  ) {
    throw new Error(`Capability "${capability.name}" uses must contain non-empty Toolkit names`);
  }
  if (new Set(capability.uses).size !== capability.uses.length) {
    throw new Error(`Capability "${capability.name}" uses must not contain duplicates`);
  }
  if (
    !capability.instructions
    || typeof capability.instructions !== 'object'
    || typeof capability.instructions.content !== 'string'
    || !capability.instructions.content.trim()
    || typeof capability.instructions.digest !== 'string'
  ) {
    throw new Error(`Capability "${capability.name}" instructions must be an InstructionDocument`);
  }
  const cachedInstructions = validatedInstructionDocuments.get(capability);
  if (
    cachedInstructions?.content !== capability.instructions.content
    || cachedInstructions.digest !== capability.instructions.digest
  ) {
    const expectedDigest = createHash('sha256')
      .update(capability.instructions.content, 'utf8')
      .digest('hex');
    if (capability.instructions.digest !== expectedDigest) {
      throw new Error(`Capability "${capability.name}" instruction digest does not match content`);
    }
    validatedInstructionDocuments.set(capability, {
      content: capability.instructions.content,
      digest: capability.instructions.digest,
    });
  }
  if (capability.lifecycle?.finalize && typeof capability.lifecycle.finalize !== 'function') {
    throw new Error(`Capability "${capability.name}" lifecycle.finalize must be a function`);
  }
  return capability;
}
