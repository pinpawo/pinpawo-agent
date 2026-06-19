import type { CapabilityArtifactKind, CapabilityArtifactRef } from '../../types/artifact';

export type CapabilityArtifactSelector = {
  kind?: CapabilityArtifactKind;
  capabilityId?: string;
  delegationId?: string;
  turnId?: string;
  schemaName?: string;
  schemaVersion?: number;
  metadata?: Record<string, unknown>;
};

export function mergeCapabilityArtifactRefs(
  previous: CapabilityArtifactRef[],
  next: CapabilityArtifactRef[],
): CapabilityArtifactRef[] {
  if (next.length === 0) return previous;
  const byId = new Map<string, CapabilityArtifactRef>();
  for (const ref of previous) byId.set(ref.id, ref);
  for (const ref of next) byId.set(ref.id, ref);
  return [...byId.values()];
}

function metadataMatches(
  artifact: CapabilityArtifactRef,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return true;
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.is(artifact.metadata?.[key], value)) return false;
  }
  return true;
}

export function matchesCapabilityArtifact(
  artifact: CapabilityArtifactRef,
  selector: CapabilityArtifactSelector,
): boolean {
  return (!selector.kind || artifact.kind === selector.kind)
    && (!selector.capabilityId || artifact.capabilityId === selector.capabilityId)
    && (!selector.delegationId || artifact.delegationId === selector.delegationId)
    && (!selector.turnId || artifact.turnId === selector.turnId)
    && (!selector.schemaName || artifact.schema?.name === selector.schemaName)
    && (typeof selector.schemaVersion !== 'number' || artifact.schema?.version === selector.schemaVersion)
    && metadataMatches(artifact, selector.metadata);
}

export function filterCapabilityArtifacts(
  artifacts: CapabilityArtifactRef[],
  selector: CapabilityArtifactSelector,
): CapabilityArtifactRef[] {
  return artifacts.filter((artifact) => matchesCapabilityArtifact(artifact, selector));
}

export function selectLatestCapabilityArtifact(
  artifacts: CapabilityArtifactRef[],
  selector: CapabilityArtifactSelector,
): CapabilityArtifactRef | null {
  let latest: { artifact: CapabilityArtifactRef; index: number } | null = null;
  for (const [index, artifact] of artifacts.entries()) {
    if (!matchesCapabilityArtifact(artifact, selector)) continue;
    if (
      !latest
      || artifact.createdAt.localeCompare(latest.artifact.createdAt) > 0
      || (artifact.createdAt === latest.artifact.createdAt && index > latest.index)
    ) {
      latest = { artifact, index };
    }
  }
  return latest?.artifact ?? null;
}

function hasExplicitResultScope(selector: CapabilityArtifactSelector): boolean {
  return Boolean(
    selector.capabilityId
      || selector.delegationId
      || selector.turnId
      || selector.schemaName
      || (selector.metadata && Object.keys(selector.metadata).length > 0),
  );
}

export function selectCapabilityResultArtifact(
  artifacts: CapabilityArtifactRef[],
  selector: Omit<CapabilityArtifactSelector, 'kind'>,
): CapabilityArtifactRef | null {
  if (!hasExplicitResultScope(selector)) {
    throw new Error(
      'selectCapabilityResultArtifact requires capabilityId, delegationId, turnId, schemaName, or metadata; there is no global latest result.',
    );
  }
  return selectLatestCapabilityArtifact(artifacts, { ...selector, kind: 'result' });
}
