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
export type HandOffFooterArtifactRefWithKind = HandOffFooterArtifactRef & { kind: CapabilityArtifactKind };

export type HandoffMessageSource = {
  handoffFrom: MessageLane;
  delegationId: string;
  runId: string;
};
export type HandoffSourceResolver = (message: BaseMessage) => HandoffMessageSource | null;

function isArtifactKind(value: string): value is CapabilityArtifactKind {
  return value === 'result'
    || value === 'report'
    || value === 'image'
    || value === 'video'
    || value === 'audio'
    || value === 'pdf'
    || value === 'file'
    || value === 'bundle';
}

function hasArtifactFooterRefKind(
  ref: HandOffFooterArtifactRef,
): ref is HandOffFooterArtifactRefWithKind {
  return Boolean(ref.kind && ref.uri && ref.capabilityId);
}

function parseFooterArtifactLineValue(line: string): { key: string; value: string } | null {
  const separatorIndex = line.indexOf('=');
  if (separatorIndex < 0) return null;
  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

function applyFooterArtifactField(ref: HandOffFooterArtifactRef, key: string, value: string) {
  if (key === 'kind') {
    if (isArtifactKind(value)) {
      ref.kind = value;
    }
    return;
  }
  if (key === 'capability' || key === 'capabilityId') {
    ref.capabilityId = value;
    return;
  }
  if (key === 'uri') {
    ref.uri = value;
    return;
  }
  if (key === 'title') {
    ref.title = value;
    return;
  }
  if (key === 'preview') {
    ref.preview = value;
    return;
  }
  if (key === 'mimeType' || key === 'mime') {
    ref.mimeType = value;
    return;
  }
  if (key === 'id') {
    ref.id = value;
    return;
  }
  if (key === 'runId') {
    ref.runId = value;
    return;
  }
  if (key === 'delegationId') {
    ref.delegationId = value;
  }
}

export function parseHandoffArtifactFooter(text: string): {
  text: string;
  artifactRefs: HandOffFooterArtifactRefWithKind[];
} {
  const match = text.match(/\s*<artifacts>[\s\S]*?<\/artifacts>\s*$/);
  if (!match || match.index === undefined) {
    return { text, artifactRefs: [] };
  }

  const footer = match[0];
  const artifactBody = footer
    .replace(/^\s*<artifacts>/, '')
    .replace(/<\/artifacts>\s*$/, '');

  const artifactRefs: HandOffFooterArtifactRefWithKind[] = [];
  let current: HandOffFooterArtifactRef | null = null;

  for (const rawLine of artifactBody.split('\n')) {
    const line = rawLine.trimEnd();
    const normalized = line.trim();
    if (!normalized) continue;

    if (normalized.startsWith('- ')) {
      if (current && hasArtifactFooterRefKind(current)) {
        artifactRefs.push(current);
      }
      const nextCurrent: HandOffFooterArtifactRef = {
        id: `${artifactRefs.length + 1}`,
        kind: undefined,
        mimeType: 'application/octet-stream',
        uri: '',
        title: undefined,
        preview: undefined,
        capabilityId: '',
        delegationId: '',
        runId: '',
      };
      const firstLine = parseFooterArtifactLineValue(normalized.slice(2));
      if (firstLine) {
        applyFooterArtifactField(nextCurrent, firstLine.key, firstLine.value);
      }
      current = nextCurrent;
      continue;
    }

    if (!current) continue;
    const parsed = parseFooterArtifactLineValue(normalized);
    if (!parsed) continue;
    applyFooterArtifactField(current, parsed.key, parsed.value);
  }

  if (current && hasArtifactFooterRefKind(current)) {
    artifactRefs.push(current);
  }

  return {
    text: text.slice(0, match.index).trimEnd(),
    artifactRefs,
  };
}

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
