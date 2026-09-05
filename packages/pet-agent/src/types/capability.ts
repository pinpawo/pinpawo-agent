import type { BaseMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertCapabilityDocumentMatches } from './capabilityDocument';
import type { AgentActor, AgentModels } from './agent';
import type { SubagentResult } from './subagent';
import type { CapabilityArtifactRef, CapabilityArtifactStore } from './artifact';

export type CapabilityDocumentSource = {
  readonly kind: 'file';
  readonly filePath: string;
  /** Complete authored CAPABILITY.md source captured for this generation. */
  readonly content: string;
  /** SHA-256 of the complete authored CAPABILITY.md source. */
  readonly digest: string;
};

export type InstructionDocument = {
  readonly content: string;
  readonly digest: string;
};

export type CapabilityFinalizeContext = {
  models: AgentModels;
  actor?: AgentActor;
  /** Read-only capability-lane history captured before this subagent run. */
  messages: readonly BaseMessage[];
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

export type AgentCapability = {
  readonly name: string;
  readonly description: string;
  /**
   * Required Toolkit dependencies and the complete tool permission boundary
   * for this Capability.
   */
  readonly uses: readonly string[];
  readonly instructions: InstructionDocument;
  /**
   * Optional authored CAPABILITY.md provenance.
   *
   * Inline definitions omit this field and are rendered into a normalized
   * document when a Capability Document Workspace is materialized.
   */
  readonly document?: CapabilityDocumentSource;
  readonly lifecycle?: CapabilityLifecycle;
};

/**
 * Well-known name for the host's general-purpose Capability. It uses the same
 * contract, supervisor selection, lane, and executor path as every Capability.
 * The supervisor candidate policy uses it as the default unless the Agent runtime
 * explicitly configures another registered Capability.
 */
export const GENERAL_CAPABILITY_NAME = 'general';

export function defineInstructionDocument(params: {
  content: string;
}): InstructionDocument {
  const content = params.content.trim();
  if (!content) {
    throw new Error('Capability instructions must be a non-empty Markdown document');
  }
  return Object.freeze({
    content,
    digest: createHash('sha256').update(content, 'utf8').digest('hex'),
  });
}

export function defineCapabilityDocumentSource(params: {
  filePath: string;
  content: string;
}): CapabilityDocumentSource {
  if (!isAbsolute(params.filePath)) {
    throw new Error('Capability document source path must be absolute');
  }
  return Object.freeze({
    kind: 'file',
    filePath: params.filePath,
    content: params.content,
    digest: createHash('sha256').update(params.content, 'utf8').digest('hex'),
  });
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
  const expectedDigest = createHash('sha256')
    .update(capability.instructions.content, 'utf8')
    .digest('hex');
  if (capability.instructions.digest !== expectedDigest) {
    throw new Error(`Capability "${capability.name}" instruction digest does not match content`);
  }
  if (capability.document !== undefined) {
    if (
      !capability.document
      || typeof capability.document !== 'object'
      || capability.document.kind !== 'file'
      || typeof capability.document.filePath !== 'string'
      || !isAbsolute(capability.document.filePath)
      || typeof capability.document.content !== 'string'
      || !capability.document.content
      || typeof capability.document.digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(capability.document.digest)
    ) {
      throw new Error(
        `Capability "${capability.name}" document must be an absolute file source with a SHA-256 digest`,
      );
    }
    const documentDigest = createHash('sha256')
      .update(capability.document.content, 'utf8')
      .digest('hex');
    if (documentDigest !== capability.document.digest) {
      throw new Error(
        `Capability "${capability.name}" document digest does not match its captured source`,
      );
    }
    assertCapabilityDocumentMatches(
      capability,
      capability.document.content,
      capability.document.filePath,
    );
  }
  if (capability.lifecycle?.finalize && typeof capability.lifecycle.finalize !== 'function') {
    throw new Error(`Capability "${capability.name}" lifecycle.finalize must be a function`);
  }
  return capability;
}
