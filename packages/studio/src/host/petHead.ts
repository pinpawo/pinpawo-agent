import type { Deliverable } from '@pinpawo/agent-contracts';
import { type PetDispatchQueueSnapshot } from 'pinpawo/host-runtime';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { observeHeadDispatch, type HeadTaskFact, type HeadSessionRunReader } from './petHeadProgress';
import { createHeadModel, type HeadRelevanceDiagnostic } from './petHeadModel';

/** The committed Timeline message as seen by a Pet. */
export type HeadMessage = {
  sequence: number;
  messageId: string;
  channelId: string;
  author: { kind: 'human' | 'pet'; id: string };
  occurredAt: string;
  body: string;
  replyTo?: string;
  mentions: Array<{ participantId: string; label?: string }>;
  deliverables?: Deliverable[];
  externalRef?: string;
};
export type HeadContext = {
  messages: HeadMessage[];
  channel?: { title: string; description?: string; prompt?: string };
  members?: Array<{ kind: 'human' | 'pet'; id: string; participantId: string; label?: string }>;
  referencedMessage?: HeadMessage;
  [key: string]: unknown;
};
export type HeadRelevance = { relevant: boolean };
export type HeadDispatchDecision = { shouldDispatch: boolean; reply: string | null };
export type HeadInput = { pet: StudioPetRegistration; description?: string; message: HeadMessage; context: HeadContext; addressed?: boolean };
export type HeadDispatchInput = HeadInput & { tasks?: HeadTaskFact[] };

/** Mentions are server-resolved participant IDs on this committed message, not labels or quoted/history text. */
export function isHeadAddressed(input: Pick<HeadInput, 'pet' | 'context' | 'message'>): boolean {
  const member = input.context.members?.find(item => item.kind === 'pet' && item.id === input.pet.petId);
  return !!member && input.message.mentions.some(item => item.participantId === member.participantId);
}

type HeadReplyOptions = { preventPetMentions?: boolean };

/** The Head's narrow view of its owner Channel. */
export type PetHeadChannel = {
  subscribe(handler: (message: HeadMessage) => Promise<void>): () => void;
  readContext(petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(petId: string, messageId: string, signal: AbortSignal, boundSessionId?: string): Promise<unknown>;
  readBoundSessionId?(petId: string): Promise<string | undefined>;
  readSessionPlan?: (petId: string, ...args: Parameters<HeadSessionRunReader>) => ReturnType<HeadSessionRunReader>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, messageId: string, signal: AbortSignal, boundSessionId?: string): Promise<unknown>;
  readBoundSessionId?(channelId: string, petId: string): Promise<string | undefined>;
  readSessionPlan?: (channelId: string, ...args: Parameters<NonNullable<PetHeadChannel['readSessionPlan']>>) => ReturnType<HeadSessionRunReader>;
};

/** Bind Channel operations and the Studio live bus to this instance's owner Channel. */
export function bindPetHeadChannel(
  channelId: string,
  operations: PetHeadChannelOperations,
  subscribe: Studio['subscribe'],
): PetHeadChannel {
  const snapshot = operations.readSessionPlan;
  const readBoundSessionId = operations.readBoundSessionId;
  return {
    subscribe: handler => subscribe(async event => {
      if (event.source !== 'channel' || event.topic !== channelId || event.type !== 'channel.message.created') return;
      const message = event.payload as HeadMessage | undefined;
      if (!message || message.channelId !== channelId || !message.author) return;
      await handler(message);
    }, { source: 'channel', topic: channelId }),
    readContext: (petId, before, replyTo) => operations.readContext(channelId, petId, before, replyTo),
    reply: (petId, messageId, body, signal, options) => operations.reply(channelId, petId, messageId, body, signal, options),
    dispatch: (...args) => operations.dispatch(channelId, ...args),
    ...(readBoundSessionId ? { readBoundSessionId: (petId: string) => readBoundSessionId(channelId, petId) } : {}),
    ...(snapshot ? { readSessionPlan: (...args: Parameters<NonNullable<PetHeadChannel['readSessionPlan']>>) => snapshot(channelId, ...args) } : {}),
  };
}

/** Attach the Head to one live Pet; PetInstance owns the signal and calls the disposer. */
export function attachPetHead(input: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannelOperations;
  subscribe: Studio['subscribe'];
  getQueueSnapshot: () => PetDispatchQueueSnapshot;
  resolveModel: () => StudioModelEndpoint;
  onDiagnostic?: (event: HeadRelevanceDiagnostic) => void;
}, signal: AbortSignal): () => void {
  signal.throwIfAborted();
  const { pet, description, subscribe } = input;
  const channel = bindPetHeadChannel(pet.channelId, input.channel, subscribe);
  const readSessionPlan = channel.readSessionPlan;
  const model = createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic });
  const observation = observeHeadDispatch({ petId: pet.petId, channelId: pet.channelId, subscribe, snapshot: input.getQueueSnapshot }, signal);
  let unsubscribe: () => void;
  try {
    const handleMessage = createPetHead({
      pet,
      ...(description ? { description } : {}),
      channel,
      readSession: (sessionId, sourceIds) => observation.readSession(sessionId, sourceIds, readSessionPlan
        ? (...args) => readSessionPlan(pet.petId, ...args) : undefined),
      assessRelevance: model.assessRelevance,
      decideDispatch: model.decideDispatch,
    });
    unsubscribe = channel.subscribe(message => handleMessage(message, signal));
  } catch (error) {
    // PetInstance will abort on activation failure, but never received a
    // disposer. Release the subscription already registered by the Head.
    observation.close();
    throw error;
  }
  return () => {
    try { unsubscribe(); }
    finally { observation.close(); }
  };
}

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readSession?: (sessionId: string, sourceIds: ReadonlySet<string>) => Promise<HeadTaskFact[]>;
  assessRelevance: (input: HeadInput, signal: AbortSignal) => Promise<HeadRelevance>;
  decideDispatch: (input: HeadDispatchInput, signal: AbortSignal) => Promise<HeadDispatchDecision>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    // Automated Head replies stay in the Timeline but never trigger another Head.
    if (message.author.kind === 'pet' && message.replyTo &&
      message.externalRef === `head-reply:${message.replyTo}`) return;
    // The exclusive bound keeps the current message out of its own history.
    const context = await options.channel.readContext(options.pet.petId, message.sequence, message.replyTo);
    if (signal.aborted) return;
    const base = { pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context };
    const input = { ...base, addressed: isHeadAddressed(base) };
    if (!input.addressed && !(await options.assessRelevance(input, signal)).relevant) return;
    if (signal.aborted) return;

    const boundSessionId = await options.channel.readBoundSessionId?.(options.pet.petId);
    if (signal.aborted) return;
    const sources = [...context.messages, ...(context.referencedMessage ? [context.referencedMessage] : [])]
      .filter(source => source.channelId === message.channelId && source.sequence < message.sequence);
    const sourceIds = new Set(sources.map(source => source.messageId));
    // A reply to a Head acknowledgement still refers to its original source.
    for (const source of sources) {
      if (source.author.kind === 'pet' && source.author.id === options.pet.petId && source.replyTo &&
        source.externalRef === `head-reply:${source.replyTo}`) sourceIds.add(source.replyTo);
    }
    const tasks = boundSessionId ? await options.readSession?.(boundSessionId, sourceIds) : undefined;
    if (signal.aborted) return;
    const decision = await options.decideDispatch({ ...input, ...(tasks?.length ? { tasks } : {}) }, signal);
    if (signal.aborted) return;
    let reply = decision.reply?.trim() ?? '';
    let dispatchFailure: string | undefined;
    if (decision.shouldDispatch) {
      try {
        if (boundSessionId) await options.channel.dispatch(options.pet.petId, message.messageId, signal, boundSessionId);
        else await options.channel.dispatch(options.pet.petId, message.messageId, signal);
      } catch (error) {
        dispatchFailure = error instanceof Error && error.name === 'TimeoutError' ? 'dispatch timed out' : 'dispatch';
      }
    }
    if (signal.aborted) return;
    if (dispatchFailure) {
      const note = dispatchFailure === 'dispatch timed out' ? '派发超时，本次没有入队。' : '本次未能确认新任务已提交。';
      reply = reply ? `${reply}\n\n${note}` : note;
    }
    let replyFailed = false;
    if (reply) {
      const peer = message.author.kind === 'pet';
      try {
        await options.channel.reply(options.pet.petId, message.messageId, reply, signal, peer ? { preventPetMentions: true } : undefined);
      } catch { replyFailed = true; }
    }
    const failures = [replyFailed ? 'reply' : undefined, dispatchFailure].filter(Boolean);
    if (failures.length) throw new Error(`Pet Head processing failed: ${failures.join(', ')}.`);
  };
}
