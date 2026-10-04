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
  pendingInterrupt: { payload: { interactions: { view: { kind: string; body?: string; title?: string } }[] } };
};

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
