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
  artifacts: ArtifactReference[]; mentions: { participantId?: string; petId?: string; label?: string }[];
  /** Tools the Pet called in this message, exactly as it called them. */
  toolCalls?: ChannelToolCall[];
};
export type ChannelToolCall = {
  id: string; name: string; args: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
};

/** A call as one line: what it was asked to do, else the tool's name. */
export function channelToolCallTitle(call: Pick<ChannelToolCall, 'name' | 'args'>): string {
  const { args } = call;
  const subject = call.name === 'delegate_capability' ? args.briefing
    : call.name === 'plan_request' ? args.goal
    : call.name === 'submit_plan' ? planSubject('计划', args.tasks)
    : call.name === 'adjust_plan' ? planSubject('调整计划', args.tasks)
    : call.name === 'review_current' && typeof args.reason === 'string'
      ? `${args.completed === true ? '验收通过' : '未通过验收'}：${args.reason}` : undefined;
  const line = typeof subject === 'string' ? subject.split('\n').find(part => part.trim())?.trim() : undefined;
  return line || call.name;
}

function planSubject(label: string, tasks: unknown) {
  const objectives = Array.isArray(tasks) ? tasks.flatMap(task =>
    task && typeof task === 'object' && typeof (task as { objective?: unknown }).objective === 'string'
      ? [(task as { objective: string }).objective] : []) : [];
  return objectives.length ? `${label}：${objectives.join('；')}` : undefined;
}

/** The detail a call carries: a delegation's briefing as written, otherwise its arguments. */
export function channelToolCallDetail(call: Pick<ChannelToolCall, 'name' | 'args'>): { markdown?: string; json?: string } {
  if (call.name === 'delegate_capability' && typeof call.args.briefing === 'string') return { markdown: call.args.briefing };
  return Object.keys(call.args).length ? { json: JSON.stringify(call.args, null, 2) } : {};
}

/** What a message says in one line, for quotes: its text, else what it called. */
export function channelMessageSummary(message: Pick<ChannelMessage, 'body' | 'toolCalls'>): string {
  return message.body.trim() ? channelQuote(message.body) : channelQuote((message.toolCalls ?? []).map(channelToolCallTitle).join(' · '));
}
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
  participants?: ChannelParticipant[];
  viewerParticipantId?: string;
};
export type ChannelParticipant = { participantId: string; kind: string; id: string; label: string };
export type DispatchQueueEntry = { dispatchId: string; enqueuedAt: string; sessionId?: string; scope?: { namespace: string; id: string } };
export type DispatchQueue = {
  petId: string; state: 'open' | 'busy' | 'waiting' | 'blocked'; activeOperation: 'conversation' | 'dispatch' | null;
  queuedConversations: number; queuedDispatches: number; entries?: DispatchQueueEntry[]; activeDispatch?: DispatchQueueEntry;
};

/** Reply preselects a registered author; labels and removed identities never route. */
export function channelReplyRecipientId(author: ChannelMessage['author'] | undefined, participants: ChannelParticipant[] = []): string {
  return participants.find(item => item.kind === author?.kind && item.id === author?.id)?.participantId ?? '';
}

export function channelAuthorParticipantId(author: ChannelMessage['author'], participants: ChannelParticipant[] = []): string {
  const registered = participants.find(item => item.kind === author.kind && item.id === author.id);
  if (registered) return registered.participantId;
  const encoded = encodeURIComponent(author.id).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${author.kind}:${encoded}`;
}

export function channelMentionLabel(mention: ChannelMessage['mentions'][number], participants: ChannelParticipant[], pets: ChannelPet[], viewerParticipantId?: string): string {
  const id = mention.participantId ?? channelAuthorParticipantId({ kind: 'pet', id: mention.petId ?? '' }, participants);
  if (id === viewerParticipantId) return 'Me';
  const participant = participants.find(item => item.participantId === id);
  if (participant) return participant.label;
  if (mention.petId) return channelPetIdentity(mention.petId, pets).name;
  return mention.label ?? id;
}

/** Composer serializes an explicit identity. Channel owns parsing and validation. */
export function channelMessageInput(channelId: string, participantId: string, body: string, reply?: ChannelMessage) {
  if (!body.trim()) throw new Error('Enter a message.');
  if (reply && reply.channelId !== channelId) throw new Error('Reply target is outside this Channel.');
  return { channelId, body: body.trim(), ...(participantId ? { mentions: [{ participantId }] } : {}),
    ...(reply ? { replyTo: reply.messageId } : {}) };
}
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

export function channelMessageIdentity(message: ChannelMessage, pets: ChannelPet[], registryKnown = true,
  participants: ChannelParticipant[] = [], viewerParticipantId?: string) {
  const participantId = channelAuthorParticipantId(message.author, participants);
  if (participantId === viewerParticipantId) return { name: 'Me', removed: false };
  const participant = participants.find(item => item.participantId === participantId);
  if (participant) return { name: participant.label, removed: false };
  return message.author.kind === 'pet'
    ? channelPetIdentity(message.author.id, pets, registryKnown)
    : { name: message.author.id === 'studio-operator' ? 'Studio operator' : message.author.id, removed: false };
}

export function channelMessageExecution(message: ChannelMessage, executions: ChannelExecution[]) {
  return channelMessageExecutions(message, executions)[0];
}

export function channelMessageExecutions(message: ChannelMessage, executions: ChannelExecution[]) {
  return executions.filter(item => item.channelId === message.channelId && (item.messageId === message.messageId
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

export function executionLabel(execution: ChannelExecution, connected: boolean): string {
  if ((execution.observationLost || !connected) && ['admitting', 'queued', 'running', 'waiting'].includes(execution.state)) return 'status unknown';
  if (execution.state === 'waiting') return 'review requested';
  if (execution.state === 'completed') return 'invocation ended';
  return execution.state;
}
