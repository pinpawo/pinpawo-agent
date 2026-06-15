import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import type { ZodType } from 'zod';
import type {
  CapabilityArtifactKind,
  CapabilityArtifactMarker,
  CapabilityArtifactRef,
  CapabilityArtifactStore,
  CapabilityArtifactWriteInput,
} from '../../types/artifact';

const PINPAWO_NAMESPACE = 'pinpawo';
const ARTIFACT_MARKERS_KEY = 'capabilityArtifacts';
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<CapabilityArtifactKind>([
  'result',
  'report',
  'image',
  'video',
  'audio',
  'pdf',
  'file',
  'bundle',
]);

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readKind(value: unknown): CapabilityArtifactKind | undefined {
  const kind = readString(value);
  return kind && ARTIFACT_KINDS.has(kind) ? kind as CapabilityArtifactKind : undefined;
}

function readSchema(value: unknown) {
  const record = readRecord(value);
  const name = readString(record?.name);
  const version = readNumber(record?.version);
  return name && version !== undefined ? { name, version } : undefined;
}

function readMetadata(value: unknown): Record<string, unknown> | undefined {
  return readRecord(value) ?? undefined;
}

export function readCapabilityArtifactMarkers(message: BaseMessage): CapabilityArtifactMarker[] {
  const additionalKwargs = readRecord((message as { additional_kwargs?: unknown }).additional_kwargs);
  const pinpawo = readRecord(additionalKwargs?.[PINPAWO_NAMESPACE]);
  const rawMarkers = pinpawo?.[ARTIFACT_MARKERS_KEY];
  if (!Array.isArray(rawMarkers)) return [];

  const markers: CapabilityArtifactMarker[] = [];
  for (const rawMarker of rawMarkers) {
    const record = readRecord(rawMarker);
    const kind = readKind(record?.kind);
    const mimeType = readString(record?.mimeType);
    if (!kind || !mimeType) continue;
    markers.push({
      kind,
      mimeType,
      title: readString(record?.title),
      preview: readString(record?.preview),
      schema: readSchema(record?.schema),
      metadata: readMetadata(record?.metadata),
      content: record?.content,
      sourceUri: readString(record?.sourceUri),
      existingUri: readString(record?.existingUri),
    });
  }
  return markers;
}

export function hasCapabilityResultMarker(messages: BaseMessage[]): boolean {
  return messages.some((message) =>
    readCapabilityArtifactMarkers(message).some((marker) => marker.kind === 'result' && marker.content !== undefined),
  );
}

export function readCapabilityResultValue(messages: BaseMessage[]): unknown | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const markers = readCapabilityArtifactMarkers(messages[index]);
    for (let markerIndex = markers.length - 1; markerIndex >= 0; markerIndex -= 1) {
      const marker = markers[markerIndex];
      if (marker?.kind === 'result' && marker.content !== undefined) {
        return marker.content;
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (ToolMessage.isInstance(message) && message.artifact !== undefined) {
      return message.artifact;
    }
  }

  return null;
}

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

export async function collectCapabilityArtifactRefs(params: {
  messages: BaseMessage[];
  store?: CapabilityArtifactStore;
  threadId?: string | null;
  capabilityId: string;
  delegationId: string;
  turnId: string;
  resultSchema?: ZodType;
}): Promise<CapabilityArtifactRef[]> {
  if (!params.store || !params.threadId) return [];
  const inputs: CapabilityArtifactWriteInput[] = [];
  for (const message of params.messages) {
    for (const marker of readCapabilityArtifactMarkers(message)) {
      if (marker.kind === 'result' && params.resultSchema && marker.content !== undefined) {
        const parsed = params.resultSchema.safeParse(marker.content);
        if (!parsed.success) continue;
        marker.content = parsed.data;
      }
      const input: CapabilityArtifactWriteInput = {
        threadId: params.threadId,
        capabilityId: params.capabilityId,
        delegationId: params.delegationId,
        turnId: params.turnId,
        marker,
      };
      inputs.push(input);
    }
  }
  return params.store.writeArtifacts
    ? params.store.writeArtifacts(inputs)
    : Promise.all(inputs.map((input) => params.store!.writeArtifact(input)));
}
