export type ChannelGoal = {
  kind: 'revision'; channelId: string; sequence: number; title: string;
  goal: string; scope: string; reason: string; occurredAt: string;
  author: { kind: string; id: string }; references: ArtifactReference[];
};
type ArtifactReference = { uri: string; label?: string; version?: string };
export type ChannelMessage = {
  kind: 'message'; channelId: string; sequence: number; messageId: string; body: string;
  author: { kind: string; id: string }; occurredAt: string; revision: number; replyTo?: string;
  source?: { petId: string; sessionId: string; invocationId: string };
  artifacts: ArtifactReference[]; mentions: { petId: string }[];
};
export type ChannelEntry = ChannelGoal | ChannelMessage;
export type ChannelExecution = {
  sequence: number; executionId: string; channelId: string; petId: string; sessionId: string;
  messageId?: string; invocationId?: string;
  state: 'admitting' | 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
  occurredAt: string; error?: string; deliveryError?: string; observationLost: boolean;
};
export type ChannelContext = {
  channel: ChannelGoal;
  sessions: { petId: string; sessionId: string; registered: boolean }[];
  history: { entries: ChannelEntry[]; nextAfter: number; hasMore: boolean };
};
export type ChannelNotice = {
  sequence: number; occurredAt: string;
  source: { petId: string; sessionId: string; invocationId: string };
  pendingInterrupt: { interruptId?: string; payload: { interactions: { view: { kind: string; body?: string; title?: string } }[] } };
};

export type ChannelPet = { petId: string; name: string };

/** Names are presentation only; stable Pet IDs remain the routing identity. */
export function channelPetIdentity(petId: string, pets: ChannelPet[], registryKnown = true) {
  const pet = pets.find(item => item.petId === petId);
  const name = pet?.name.trim() || petId;
  const duplicate = pets.filter(item => (item.name.trim() || item.petId) === name).length > 1;
  return { name, removed: registryKnown && !pet, optionLabel: duplicate ? `${name} (${petId})` : name };
}

export function channelMessageIdentity(message: ChannelMessage, pets: ChannelPet[], registryKnown = true) {
  return message.author.kind === 'pet'
    ? channelPetIdentity(message.author.id, pets, registryKnown)
    : { name: message.author.id === 'studio-operator' ? 'Studio operator' : message.author.id, removed: false };
}

export function channelMessageExecution(message: ChannelMessage, executions: ChannelExecution[]) {
  return executions.find(item => item.channelId === message.channelId && (item.messageId === message.messageId
    || (!!message.source && item.invocationId === message.source.invocationId
      && item.petId === message.source.petId && item.sessionId === message.source.sessionId)));
}

export function channelExecutionOutputs(execution: ChannelExecution, entries: ChannelEntry[]): ChannelMessage[] {
  return entries.filter((item): item is ChannelMessage => item.kind === 'message' && item.channelId === execution.channelId
    && !!item.source && !!execution.invocationId && item.source.invocationId === execution.invocationId
    && item.source.petId === execution.petId && item.source.sessionId === execution.sessionId);
}

export function channelDateKey(occurredAt: string): string {
  const date = new Date(occurredAt);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : occurredAt;
}

export function channelMessagesGroup(previous: ChannelEntry | undefined, current: ChannelEntry, executions: ChannelExecution[]): boolean {
  if (!previous || previous.kind !== 'message' || current.kind !== 'message') return false;
  if (previous.source || current.source || previous.replyTo || current.replyTo
    || channelMessageExecution(previous, executions) || channelMessageExecution(current, executions)) return false;
  const gap = Date.parse(current.occurredAt) - Date.parse(previous.occurredAt);
  return previous.channelId === current.channelId && previous.author.kind === current.author.kind
    && previous.author.id === current.author.id && channelDateKey(previous.occurredAt) === channelDateKey(current.occurredAt)
    && gap >= 0 && gap < 5 * 60_000;
}

export function channelQuote(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Load every ordered page; reject a broken cursor rather than hiding recent results. */
export async function readChannelPages<T>(read: (path: string) => Promise<unknown>, path: string, key: string): Promise<T[]> {
  const entries: T[] = [];
  let after = 0;
  for (;;) {
    const page = await read(`${path}${path.includes('?') ? '&' : '?'}after=${after}&limit=200`) as Record<string, unknown>;
    const values = page[key];
    if (!Array.isArray(values) || typeof page.hasMore !== 'boolean' || typeof page.nextAfter !== 'number') {
      throw new Error('Invalid Channel history response.');
    }
    entries.push(...values as T[]);
    if (!page.hasMore) return entries;
    if (page.nextAfter <= after || !Number.isSafeInteger(page.nextAfter)) throw new Error('Channel history cursor did not advance.');
    after = page.nextAfter;
  }
}

export function channelExecuteInput(channelId: string, petId: string, body: string, reply?: ChannelMessage) {
  if (!body.trim()) throw new Error('Enter a message.');
  if (reply) {
    if (reply.channelId !== channelId || !reply.source) throw new Error('Reply target has no execution in this Channel.');
    return { channelId, body: body.trim(), replyTo: reply.messageId };
  }
  if (!petId) throw new Error('Select a Pet explicitly.');
  return { channelId, petId, body: body.trim() };
}

export function executionLabel(execution: ChannelExecution, connected: boolean): string {
  if ((execution.observationLost || !connected) && ['admitting', 'queued', 'running', 'waiting'].includes(execution.state)) return 'status unknown';
  if (execution.state === 'waiting') return 'review requested';
  if (execution.state === 'completed') return 'invocation ended';
  return execution.state;
}
