export type LiveEvent = { type: string; source: string; occurredAt: string; payload?: unknown };
export type DispatchState = 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
export type DispatchRecord = {
  invocationId: string;
  petId: string;
  request: string;
  producer: string;
  state: DispatchState;
  updatedAt: string;
  source: 'admission_receipt' | 'lifecycle';
  error?: string;
  observationLost?: boolean;
};

export function dispatchRecordFromEvent(event: LiveEvent): DispatchRecord | null {
  const source = event.source === 'studio' && event.type === 'dispatch.accepted'
    ? 'admission_receipt'
    : event.source === 'resident-pet' && /^dispatch\.(queued|running|waiting|completed|interrupted|failed)$/.test(event.type)
      ? 'lifecycle'
      : null;
  const state = source === 'admission_receipt'
    ? 'queued'
    : source === 'lifecycle'
      ? event.type.slice('dispatch.'.length) as DispatchState
      : null;
  if (!source || !state
    || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.invocationId !== 'string' || typeof payload.petId !== 'string'
    || typeof payload.request !== 'string') {
    return null;
  }
  return {
    invocationId: payload.invocationId,
    petId: payload.petId,
    request: payload.request,
    producer: typeof payload.producer === 'string' ? payload.producer : 'resident-pet',
    state,
    updatedAt: event.occurredAt,
    source,
    observationLost: false,
    ...(typeof payload.error === 'string' && payload.error.trim()
      ? { error: payload.error }
      : {}),
  };
}

export function appendDispatchRecord(records: DispatchRecord[], record: DispatchRecord): DispatchRecord[] {
  const existingIndex = records.findIndex(({ invocationId }) => invocationId === record.invocationId);
  if (existingIndex < 0) return [...records.slice(-199), record];
  const existing = records[existingIndex];
  if (!existing) return records;
  // Studio's receipt can arrive after the resident runtime has already emitted
  // running or terminal lifecycle. It only establishes the initial queued row;
  // merge its source attribution without regressing the execution observation.
  if (record.source === 'admission_receipt') {
    const next = [...records];
    next[existingIndex] = {
      ...existing,
      producer: record.producer,
      observationLost: existing.source === 'lifecycle'
        ? existing.observationLost : existing.observationLost || record.observationLost,
    };
    return next;
  }
  const next = [...records];
  next[existingIndex] = {
    ...existing,
    ...record,
    producer: record.source === 'lifecycle' ? existing.producer : record.producer,
  };
  return next;
}

export function markObservationLost(records: DispatchRecord[]): DispatchRecord[] {
  return records.map((record) => ['queued', 'running', 'waiting'].includes(record.state)
    ? { ...record, observationLost: true }
    : record);
}
