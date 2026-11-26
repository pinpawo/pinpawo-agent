import type { Deliverable } from '@pinpawo/agent-contracts';
import { PetDispatchRefusedError, type PetDispatchQueueSnapshot } from 'pinpawo/host-runtime';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { headProgress, readHeadSession, type HeadRun, type HeadProgressEvidence, type HeadResultMessage,
  type HeadSessionReader } from './petHeadProgress';
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
};
export type HeadRelevance = { relevant: boolean };
/** Decide whether the current message requests independent work, without using progress as evidence. */
export type HeadNewWorkResult = { shouldDispatch: boolean; reply: string | null };
type HeadDispatchRef = { dispatchId: string; sessionId: string; messageId?: string };
type HeadWorkState = { kind: 'idle' } | { kind: 'unknown' } | { kind: 'active'; dispatch: HeadDispatchRef };

/** Idle means the ordinary resident dispatch slot is clear, not that a historical Session finished. */
export function readHeadWorkState(channelId: string, queue: PetDispatchQueueSnapshot): HeadWorkState {
  const entry = queue.activeDispatch;
  if (queue.state === 'busy' && queue.activeOperation === 'dispatch' && entry?.dispatchId && entry.sessionId &&
    entry.scope?.namespace === 'channel' && entry.scope.id === channelId) {
    return { kind: 'active', dispatch: { dispatchId: entry.dispatchId, sessionId: entry.sessionId,
      messageId: entry.origin?.namespace === 'channel' ? entry.origin.id : undefined } };
  }
  if (queue.state === 'open' && queue.activeOperation === null && !entry && queue.queuedConversations === 0 && queue.queuedDispatches === 0) {
    return { kind: 'idle' };
  }
  return { kind: 'unknown' };
}
export type HeadInput = { pet: StudioPetRegistration; description?: string; message: HeadMessage; context: HeadContext; addressed?: boolean };

/** Model-visible facts only; the live run identity and freshness guard stay in the Head. */
type HeadSource = Pick<HeadMessage, 'messageId' | 'body'>;
export type HeadRunningFacts = { evidence: Extract<HeadProgressEvidence, { status: 'running' }>; source: HeadSource };
export type HeadSessionFacts = HeadRunningFacts | { evidence: Exclude<HeadProgressEvidence, HeadRunningFacts['evidence']> };
export type HeadReplyInput = { message: HeadMessage; evidence: HeadProgressEvidence; source?: HeadSource };
export type HeadRunningResult = { delivery: 'queue' | null; reply: string | null };
type HeadDelivery = { kind: 'queue'; sessionId: string };

/** Mentions are server-resolved participant IDs on this committed message, not labels or quoted/history text. */
export function isHeadAddressed(input: Pick<HeadInput, 'pet' | 'context' | 'message'>): boolean {
  const member = input.context.members?.find(item => item.kind === 'pet' && item.id === input.pet.petId);
  return !!member && input.message.mentions.some(item => item.participantId === member.participantId);
}

type HeadReplyOptions = { preventPetMentions?: boolean; assertCurrent?: () => void };
class StaleProgressReply extends Error {}

/** The Head's narrow view of its owner Channel. */
export type PetHeadChannel = {
  subscribe(handler: (message: HeadMessage) => Promise<void>): () => void;
  readContext(petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(petId: string, messageId: string, signal: AbortSignal, options?: HeadDelivery): Promise<unknown>;
  readSession: (petId: string, ...args: Parameters<HeadSessionReader>) => ReturnType<HeadSessionReader>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, messageId: string, signal: AbortSignal, options?: HeadDelivery): Promise<unknown>;
  readSession: (channelId: string, ...args: Parameters<PetHeadChannel['readSession']>) => ReturnType<HeadSessionReader>;
};

/** Bind Channel operations and the Studio live bus to this instance's owner Channel. */
export function bindPetHeadChannel(
  channelId: string,
  operations: PetHeadChannelOperations,
  subscribe: Studio['subscribe'],
): PetHeadChannel {
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
    readSession: (...args) => operations.readSession(channelId, ...args),
  };
}

/** Bind the live ports for one Pet activation. PetInstance owns the activation signal. */
export function attachPetHead(input: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannelOperations;
  subscribe: Studio['subscribe'];
  getQueueSnapshot: () => PetDispatchQueueSnapshot;
  resolveModel: () => StudioModelEndpoint;
  onDiagnostic?: (event: HeadRelevanceDiagnostic) => void;
}, signal: AbortSignal): () => void {
  const { pet, description, subscribe } = input;
  const head = createPetHead({
    pet,
    description,
    channel: bindPetHeadChannel(pet.channelId, input.channel, subscribe),
    readWorkState: () => readHeadWorkState(pet.channelId, input.getQueueSnapshot()),
    model: createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic }),
    observeRun: activeSignal => observeHeadRun(subscribe, pet.petId, pet.channelId, activeSignal),
  });
  head.start(signal);
  return head.close;
}

type HeadRunReader = {
  read(active: HeadDispatchRef): HeadRun | undefined;
  readResult?(active: HeadDispatchRef): HeadResultMessage | undefined;
};
type HeadRunObservation = HeadRunReader & { close(): void };

/** Correlate only this Pet's live run and its public result ID, never raw result text. */
export function observeHeadRun(subscribe: Studio['subscribe'], petId: string, channelId: string, signal: AbortSignal) {
  let current: HeadRun | undefined;
  let result: HeadResultMessage | undefined;
  const unsubscribe = subscribe(event => {
    if (signal.aborted || event.source !== 'resident-pet' || event.topic !== petId) return;
    const payload = event.payload as Partial<{
      petId: string; invocationId: string; sessionId: string; requestId: string;
      scope: { namespace: string; id: string };
      message: { type?: unknown; messageId?: unknown };
    }> | undefined;
    if (!payload || payload.petId !== petId || payload.scope?.namespace !== 'channel' || payload.scope.id !== channelId ||
      typeof payload.invocationId !== 'string' || !payload.invocationId || typeof payload.sessionId !== 'string' || !payload.sessionId ||
      typeof payload.requestId !== 'string' || !payload.requestId) return;
    const { invocationId, sessionId, requestId } = payload;
    const matches = current && current.invocationId === invocationId && current.sessionId === sessionId && current.requestId === requestId;
    if (event.type === 'dispatch.running') {
      current = { invocationId, sessionId, requestId };
      if (!matches) result = undefined;
    } else if (matches && event.type === 'dispatch.message' && payload.message?.type === 'message.completed' &&
      typeof payload.message.messageId === 'string' && payload.message.messageId) {
      result = { messageId: payload.message.messageId, requestId };
    } else if (matches && ['dispatch.waiting', 'dispatch.completed', 'dispatch.failed', 'dispatch.interrupted'].includes(event.type)) {
      current = undefined;
      result = undefined;
    }
  }, { source: 'resident-pet', topic: petId });
  const read = (active: HeadDispatchRef) => !signal.aborted && current?.invocationId === active.dispatchId && current.sessionId === active.sessionId
    ? current : undefined;
  return { close: () => { current = undefined; result = undefined; unsubscribe(); }, read,
    readResult: (active: HeadDispatchRef) => read(active) ? result : undefined };
}

type CurrentRun = { run: HeadRun; isCurrent: () => boolean };
type DispatchContext = { kind: 'new-work'; delivery?: HeadDelivery } |
  { kind: 'existing'; facts: HeadSessionFacts; current?: CurrentRun };

/** One Pet's Head, with its own Timeline subscription and run observation. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readWorkState: () => HeadWorkState;
  observeRun?: (signal: AbortSignal) => HeadRunObservation;
  model: Pick<ReturnType<typeof createHeadModel>, 'assessRelevance' | 'decideNewWorkAndReply' | 'suggestDispatchForExistingWork'>;
}) {
  const { channel, model, pet } = options;
  let dispose: (() => void) | undefined;

  function start(parentSignal: AbortSignal) {
    parentSignal.throwIfAborted();
    if (dispose) throw new Error('Pet Head is already attached.');
    const activation = new AbortController();
    const signal = AbortSignal.any([parentSignal, activation.signal]);
    let observation: HeadRunObservation | undefined;
    try {
      observation = options.observeRun?.(signal);
      const unsubscribe = channel.subscribe(message => receive(message, signal, observation));
      dispose = () => {
        // Fence an in-flight turn even when closed directly by its owner.
        activation.abort();
        try { unsubscribe(); }
        finally { observation?.close(); }
      };
    } catch (error) {
      activation.abort();
      observation?.close();
      throw error;
    }
  }

  function close() {
    const stop = dispose;
    dispose = undefined;
    stop?.();
  }

  const slotIsIdle = () => options.readWorkState().kind === 'idle';
  const blocked = (status: 'unavailable' | 'waiting' = 'unavailable'): DispatchContext =>
    ({ kind: 'existing', facts: { evidence: { status } } });

  const boundNewWork = (sessionId?: string): DispatchContext => sessionId
    ? { kind: 'new-work', delivery: { kind: 'queue', sessionId } }
    : blocked();

  const canReadBinding = () => true; // Channel revalidates its binding and the turn signal.

  async function readWithoutProgress(signal: AbortSignal, idle: boolean): Promise<DispatchContext> {
    const isCurrent = idle ? slotIsIdle : canReadBinding;
    const sample = await readHeadSession({ signal, isCurrent,
      read: readSignal => channel.readSession(pet.petId, undefined, readSignal, isCurrent) });
    if (sample?.status === 'waiting') return blocked('waiting');
    if (idle && sample?.status === 'ready') return { kind: 'new-work' };
    // A registered Session is the submission target, not proof of any run's progress.
    // The Dispatch service alone owns queue admission, the Stop fence and its timeout.
    return boundNewWork(sample?.sessionId);
  }

  async function readDispatchContext(input: HeadInput, signal: AbortSignal, runs?: HeadRunReader): Promise<DispatchContext> {
    const state = options.readWorkState();
    if (state.kind !== 'active') return readWithoutProgress(signal, state.kind === 'idle');

    const { dispatch: active } = state;
    const run = runs?.read(active);
    const { message, context } = input;
    const reference = context.referencedMessage;
    // An explicit reference to other work does not grant access to this run.
    const targetsActive = !message.replyTo || message.replyTo === active.messageId ||
      (!!reference && !!active.messageId && reference.messageId === message.replyTo && reference.channelId === message.channelId &&
        reference.author.kind === 'pet' && reference.author.id === pet.petId &&
        reference.replyTo === active.messageId && reference.externalRef === `head-reply:${active.messageId}`);
    if (!run || !active.messageId || !targetsActive) return readWithoutProgress(signal, false);
    const isCurrent = () => {
      const now = options.readWorkState();
      return now.kind === 'active' && now.dispatch.dispatchId === active.dispatchId && now.dispatch.sessionId === active.sessionId &&
        now.dispatch.messageId === active.messageId && runs?.read(active)?.requestId === run.requestId;
    };
    if (!isCurrent()) return readWithoutProgress(signal, false);
    // A later run cannot be evidence for an earlier Timeline question.
    const isSource = (candidate: HeadMessage | undefined): candidate is HeadMessage =>
      candidate?.messageId === active.messageId && candidate?.channelId === message.channelId && candidate.sequence < message.sequence;
    let source = isSource(reference) ? reference : context.messages.find(isSource);
    if (!source) {
      const { referencedMessage } = await channel.readContext(pet.petId, message.sequence, active.messageId);
      if (isSource(referencedMessage)) source = referencedMessage;
    }
    if (!source || signal.aborted || !isCurrent()) return readWithoutProgress(signal, false);
    const result = runs?.readResult?.(active);
    const sample = await readHeadSession({ signal, isCurrent: canReadBinding,
      read: readSignal => channel.readSession(pet.petId, run.sessionId, readSignal, canReadBinding, result) });
    if (sample?.status === 'waiting') return blocked('waiting');
    const evidence = headProgress(isCurrent() ? sample : undefined, run.requestId);
    if (evidence.status !== 'running') return boundNewWork(sample?.sessionId);
    const current = { run, isCurrent };
    const facts: HeadSessionFacts = { evidence, source: { messageId: source.messageId, body: source.body } };
    return { kind: 'existing', facts, current };
  }

  async function publishReply(message: HeadMessage, reply: string | null, signal: AbortSignal, current?: CurrentRun) {
    if (signal.aborted || !reply?.trim() || (current && !current.isCurrent())) return;
    const peer = message.author.kind === 'pet';
    try {
      await channel.reply(pet.petId, message.messageId, reply, signal, peer || current ? {
        ...(peer ? { preventPetMentions: true } : {}),
        ...(current ? { assertCurrent: () => { if (!current.isCurrent()) throw new StaleProgressReply(); } } : {}),
      } : undefined);
    } catch (error) { if (!(error instanceof StaleProgressReply)) return 'reply'; }
  }

  async function submit(message: HeadMessage, signal: AbortSignal, delivery?: HeadDelivery) {
    try {
      if (delivery) await channel.dispatch(pet.petId, message.messageId, signal, delivery);
      else await channel.dispatch(pet.petId, message.messageId, signal);
      return 'accepted' as const;
    } catch (error) {
      if (error instanceof PetDispatchRefusedError || signal.aborted) return 'refused' as const;
      return error instanceof Error && error.name === 'TimeoutError' ? 'dispatch timed out' as const : 'dispatch' as const;
    }
  }

  function requireSubmission(result: Awaited<ReturnType<typeof submit>>, replyFailure?: 'reply') {
    if (result === 'accepted' || result === 'refused') return result === 'accepted';
    throw new Error('Pet Head processing failed: ' + (replyFailure ? 'reply, ' : '') + result + '.');
  }

  async function routeDispatch(input: HeadInput, signal: AbortSignal, runs?: HeadRunReader) {
    const { message } = input;
    const context = await readDispatchContext(input, signal, runs).catch(() => blocked());
    if (signal.aborted) return;
    if (context.kind === 'new-work') {
      const { shouldDispatch, reply } = await model.decideNewWorkAndReply(input, signal);
      if (context.delivery && shouldDispatch) {
        // Bound submissions wait inside Dispatch. Do not publish anything before admission.
        if (signal.aborted || !requireSubmission(await submit(message, signal, context.delivery))) return;
      }
      const replyFailure = await publishReply(message, reply, signal);
      if (!context.delivery && shouldDispatch && !signal.aborted) {
        requireSubmission(await submit(message, signal), replyFailure);
      }
      if (signal.aborted) throw new Error('Pet Head processing aborted.');
      if (replyFailure) throw new Error('Pet Head processing failed: reply.');
      return;
    }

    const { current, facts } = context;
    let suggestion: HeadRunningResult;
    try { suggestion = await model.suggestDispatchForExistingWork(input, facts, signal); }
    catch {
      if (signal.aborted) return;
      throw new Error('Pet Head execution handling failed.');
    }
    if (signal.aborted) return;
    const { delivery, reply } = suggestion;
    if (delivery !== null) {
      // A Timeline message is not a Stop control. Only submit independent work
      // against the checked binding. Freshness guards the reply, not the submission.
      if (delivery !== 'queue' || facts.evidence.status !== 'running' || !current) return;
      if (!requireSubmission(await submit(message, signal, { kind: 'queue', sessionId: current.run.sessionId }))) return;
    }
    if (await publishReply(message, reply, signal, current)) {
      throw new Error('Pet Head processing failed: reply.');
    }
  }

  async function receive(message: HeadMessage, signal: AbortSignal, runs?: HeadRunReader) {
    if (signal.aborted || message.channelId !== pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === pet.petId)) return;
    // Automated Head replies stay in the Timeline but never trigger another Head.
    if (message.author.kind === 'pet' && message.replyTo &&
      message.externalRef === `head-reply:${message.replyTo}`) return;
    // Stage 1: assess relevance from public Channel context; a canonical mention bypasses the model.
    const context = await channel.readContext(pet.petId, message.sequence, message.replyTo);
    if (signal.aborted) return;
    const base = { pet, ...(options.description ? { description: options.description } : {}), message, context };
    const input = { ...base, addressed: isHeadAddressed(base) };
    if (!input.addressed && !(await model.assessRelevance(input, signal)).relevant) return;
    // Stage 2: route dispatch from Session evidence; publication remains separate.
    if (!signal.aborted) await routeDispatch(input, signal, runs);
  }

  return { start, close, receive };
}
