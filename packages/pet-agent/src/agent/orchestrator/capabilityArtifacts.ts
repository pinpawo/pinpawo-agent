import type { CapabilityArtifactRef } from '../../types/artifact';

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
