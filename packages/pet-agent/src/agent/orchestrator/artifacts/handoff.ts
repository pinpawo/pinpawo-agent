import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { CapabilityArtifactKind, CapabilityArtifactRef } from '../../../types/artifact';
import { filterCapabilityArtifacts } from '../capabilityArtifacts';
import type { MessageLane } from '../types';
import { clipForPrompt } from '../utils';

export const MAX_HANDED_OFF_ANNOUNCE_ARTIFACT_REFS = 5;
export const MAX_HANDOFF_ARTIFACT_REFS = 5;
export const MAX_HANDOFF_ARTIFACT_URI_LENGTH = 220;
export const MAX_HANDOFF_ARTIFACT_TITLE_LENGTH = 120;
export const MAX_HANDOFF_ARTIFACT_PREVIEW_LENGTH = 180;

const HANDOFF_ARTIFACT_KIND_PRIORITY: Record<string, number> = {
  result: 0,
  report: 1,
  image: 2,
  video: 3,
  audio: 4,
  pdf: 5,
  file: 6,
  bundle: 7,
};

const HANDOFF_ARTIFACT_KINDS = [
  'result',
  'report',
  'image',
  'video',
  'audio',
  'pdf',
  'file',
  'bundle',
] as const satisfies readonly CapabilityArtifactKind[];
export const HANDOFF_ARTIFACT_KIND_SET = new Set(HANDOFF_ARTIFACT_KINDS);

export type HandOffArtifactRef = Pick<
  CapabilityArtifactRef,
  'id' | 'kind' | 'mimeType' | 'uri' | 'title' | 'preview' | 'capabilityId' | 'delegationId' | 'runId'
>;

type HandOffFooterArtifactRef = Omit<
  Pick<
    CapabilityArtifactRef,
    'id' | 'kind' | 'mimeType' | 'uri' | 'title' | 'preview' | 'capabilityId' | 'delegationId' | 'runId'
  >,
  'kind'
> & {
  kind?: CapabilityArtifactKind;
};
export type HandoffMessageSource = {
  handoffFrom: MessageLane;
  delegationId: string;
  runId: string;
};
export type HandoffSourceResolver = (message: BaseMessage) => HandoffMessageSource | null;

function serializeArtifactFooterRefs(refs: HandOffFooterArtifactRef[]) {
  return refs
    .map((ref) => {
      const fields = [
        `- kind=${clipForPrompt(ref.kind ?? 'unknown', 24)}`,
        `  capability=${clipForPrompt(ref.capabilityId, 160)}`,
        `  uri=${clipForPrompt(ref.uri, MAX_HANDOFF_ARTIFACT_URI_LENGTH)}`,
        `  id=${ref.id}`,
        `  runId=${ref.runId}`,
        `  delegationId=${ref.delegationId}`,
      ];
      if (ref.mimeType) {
        fields.push(`  mimeType=${clipForPrompt(ref.mimeType, 80)}`);
      }
      if (ref.title) {
        fields.push(`  title=${clipForPrompt(ref.title, MAX_HANDOFF_ARTIFACT_TITLE_LENGTH)}`);
      }
      if (ref.preview) {
        fields.push(`  preview=${clipForPrompt(ref.preview, MAX_HANDOFF_ARTIFACT_PREVIEW_LENGTH)}`);
      }
      return fields.filter(Boolean).join('\n');
    })
    .join('\n');
}

export function formatHandoffArtifactRefsForMessage(
  refs: Pick<
    CapabilityArtifactRef,
    'id' | 'kind' | 'mimeType' | 'uri' | 'title' | 'preview' | 'capabilityId' | 'delegationId' | 'runId'
  >[],
) {
  if (!refs.length) return '';
  const lines = ['\n\n<artifacts>'];
  lines.push(serializeArtifactFooterRefs(refs.slice(-MAX_HANDOFF_ARTIFACT_REFS)));
  lines.push('</artifacts>');
  return lines.join('\n');
}

export function compareArtifactsForHandoff(a: CapabilityArtifactRef, b: CapabilityArtifactRef) {
  const aPriority = HANDOFF_ARTIFACT_KIND_PRIORITY[a.kind] ?? 99;
  const bPriority = HANDOFF_ARTIFACT_KIND_PRIORITY[b.kind] ?? 99;
  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }
  if (a.createdAt !== b.createdAt) {
    return b.createdAt.localeCompare(a.createdAt);
  }
  return 0;
}

export function buildHandoffArtifactRefs(
  artifacts: CapabilityArtifactRef[],
  params: { delegationId: string; runId: string; capabilityId?: string | null },
): HandOffArtifactRef[] {
  const filtered = filterCapabilityArtifacts(artifacts, {
    delegationId: params.delegationId,
    runId: params.runId,
    ...(params.capabilityId ? { capabilityId: params.capabilityId } : {}),
  });

  const deduped: CapabilityArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of filtered) {
    const key = `${artifact.id}:${artifact.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(artifact);
  }

  return deduped
    .sort(compareArtifactsForHandoff)
    .slice(0, MAX_HANDED_OFF_ANNOUNCE_ARTIFACT_REFS)
    .map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      uri: artifact.uri,
      title: artifact.title,
      preview: artifact.preview,
      capabilityId: artifact.capabilityId,
      delegationId: artifact.delegationId,
      runId: artifact.runId,
    }));
}

export function findLatestHandoffCopyForDelegation(
  messages: BaseMessage[],
  delegationId: string,
  handoffFrom: MessageLane,
  runId: string,
  readHandoffSource: HandoffSourceResolver,
): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message._getType() !== 'ai') {
      continue;
    }
    const source = readHandoffSource(message);
    if (!source) {
      continue;
    }
    if (
      source.delegationId !== delegationId
      || source.handoffFrom !== handoffFrom
      || source.runId !== runId
    ) {
      continue;
    }
    return message as AIMessage;
  }
  return null;
}
