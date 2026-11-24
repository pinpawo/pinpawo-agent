import type { Deliverable } from '@pinpawo/agent-contracts';
import { PetDispatchRefusedError, type PetDispatchQueueSnapshot } from 'pinpawo/host-runtime';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { readHeadProgress, readHeadSession, type HeadRun, type HeadProgressEvidence, type HeadResultMessage,
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
  [key: string]: unknown;
};
export type HeadRelevance = { relevant: boolean };
/** This contract belongs only to the handler of a verified idle slot. */
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

export type HeadReplyInput = { message: HeadMessage; evidence: HeadProgressEvidence; source?: Pick<HeadMessage, 'messageId' | 'body'> };
export type HeadExecutionInput = HeadInput & HeadReplyInput & { mayInterrupt: boolean };
export type HeadRunningInput = HeadExecutionInput & { evidence: Extract<HeadProgressEvidence, { status: 'running' }>;
  source: Pick<HeadMessage, 'messageId' | 'body'> };
export type HeadRunningResult = { delivery: 'queue' | 'interrupt' | null; reply: string | null };
type HeadDelivery = { kind: 'queue'; sessionId: string } | { kind: 'interrupt'; expectedRun: HeadRun };

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
    dispatch: (petId, messageId, signal, options) => options ? operations.dispatch(channelId, petId, messageId, signal, options)
      : operations.dispatch(channelId, petId, messageId, signal),
    readSession: (...args) => operations.readSession(channelId, ...args),
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
  const model = createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic });
  const observation = observeHeadRun(subscribe, pet.petId, pet.channelId, signal);
  let unsubscribe: () => void;
  try {
    const handleMessage = createPetHead({
      pet,
      ...(description ? { description } : {}),
      channel,
      readWorkState: () => readHeadWorkState(pet.channelId, input.getQueueSnapshot()),
      execution: { readRun: observation.read, readResult: observation.readResult, decide: model.decideExecutionHandling },
      assessRelevance: model.assessRelevance,
      decideNewWorkAndReply: model.decideNewWorkAndReply,
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
type HandlingContext = { kind: 'ready' } | ({ kind: 'existing'; current?: CurrentRun } & Omit<HeadReplyInput, 'message'>);

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readWorkState: () => HeadWorkState;
  execution: {
    readRun: (active: HeadDispatchRef) => HeadRun | undefined;
    readResult?: (active: HeadDispatchRef) => HeadResultMessage | undefined;
    decide: (input: HeadExecutionInput, signal: AbortSignal) => Promise<HeadRunningResult>;
  };
  assessRelevance: (input: HeadInput, signal: AbortSignal) => Promise<HeadRelevance>;
  decideNewWorkAndReply: (input: HeadInput, signal: AbortSignal) => Promise<HeadNewWorkResult>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  const { channel, execution, pet } = options;
  const slotIsIdle = () => options.readWorkState().kind === 'idle';
  const blocked = (status: 'unavailable' | 'waiting' | 'interrupting' = 'unavailable'): HandlingContext =>
    ({ kind: 'existing', evidence: { status } });

  async function readHandlingContext(input: HeadInput, signal: AbortSignal): Promise<HandlingContext> {
    const state = options.readWorkState();
    if (state.kind !== 'active') {
      // A free resident slot and a ready Channel Session are different facts.
      const isCurrent = state.kind === 'idle' ? slotIsIdle : () => true;
      const sample = await readHeadSession({ signal, isCurrent,
        read: readSignal => channel.readSession(pet.petId, undefined, readSignal, isCurrent) });
      if (state.kind === 'idle' && sample?.status === 'ready') return { kind: 'ready' };
      return blocked(sample?.status === 'waiting' || sample?.status === 'interrupting' ? sample.status : 'unavailable');
    }

    const { dispatch: active } = state;
    const run = execution.readRun(active);
    const { message, context } = input;
    const reference = context.referencedMessage;
    // An explicit reference to other work does not grant access to this run.
    const targetsActive = !message.replyTo || message.replyTo === active.messageId ||
      (!!reference && !!active.messageId && reference.messageId === message.replyTo && reference.channelId === message.channelId &&
        reference.author.kind === 'pet' && reference.author.id === pet.petId &&
        reference.replyTo === active.messageId && reference.externalRef === `head-reply:${active.messageId}`);
    if (!run || !active.messageId || !targetsActive) return blocked();
    const isCurrent = () => {
      const now = options.readWorkState();
      return now.kind === 'active' && now.dispatch.dispatchId === active.dispatchId && now.dispatch.sessionId === active.sessionId &&
        now.dispatch.messageId === active.messageId && execution.readRun(active)?.requestId === run.requestId;
    };
    if (!isCurrent()) return blocked();
    // A later run cannot be evidence for an earlier Timeline question.
    const isSource = (candidate: HeadMessage | undefined): candidate is HeadMessage =>
      candidate?.messageId === active.messageId && candidate?.channelId === message.channelId && candidate.sequence < message.sequence;
    let source = isSource(reference) ? reference : context.messages.find(isSource);
    if (!source) {
      const { referencedMessage } = await channel.readContext(pet.petId, message.sequence, active.messageId);
      if (isSource(referencedMessage)) source = referencedMessage;
    }
    if (!source || signal.aborted || !isCurrent()) return blocked();
    const result = execution.readResult?.(active);
    const evidence = await readHeadProgress({ run, signal, isCurrent,
      read: readSignal => channel.readSession(pet.petId, run.sessionId, readSignal, isCurrent, result) });
    return { kind: 'existing', evidence,
      ...(evidence.status !== 'unavailable' ? { current: { run, isCurrent } } : {}),
      ...(evidence.status === 'running' ? { source: { messageId: source.messageId, body: source.body } } : {}) };
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

  async function handleRelevantMessage(input: HeadInput, signal: AbortSignal) {
    const { message } = input;
    const context = await readHandlingContext(input, signal).catch(() => blocked());
    if (signal.aborted) return;
    if (context.kind === 'ready') {
      const decision = await options.decideNewWorkAndReply(input, signal);
      // An optional pre-admission acknowledgement is not proof of acceptance.
      const replyFailure = await publishReply(message, decision.reply, signal);
      const failures: string[] = replyFailure ? [replyFailure] : [];
      if (decision.shouldDispatch && !signal.aborted && slotIsIdle()) {
        try { await channel.dispatch(pet.petId, message.messageId, signal); }
        catch (error) { if (!(error instanceof PetDispatchRefusedError)) failures.push('dispatch'); }
      }
      if (signal.aborted) throw new Error('Pet Head processing aborted.');
      if (failures.length) throw new Error('Pet Head processing failed: ' + failures.join(', ') + '.');
      return;
    }

    const { current, evidence, source } = context;
    const mayInterrupt = message.author.kind === 'human';
    let decision: HeadRunningResult;
    try { decision = await execution.decide({ ...input, evidence, source, mayInterrupt }, signal); }
    catch {
      if (signal.aborted) return;
      throw new Error('Pet Head execution handling failed.');
    }
    if (signal.aborted || (current && !current.isCurrent())) return;
    if (decision.delivery) {
      if (evidence.status !== 'running' || !current || (decision.delivery === 'interrupt' && !mayInterrupt)) return;
      const delivery: HeadDelivery = decision.delivery === 'queue' ? { kind: 'queue', sessionId: current.run.sessionId }
        : { kind: 'interrupt', expectedRun: current.run };
      try { await channel.dispatch(pet.petId, message.messageId, signal, delivery); }
      catch (error) {
        if (error instanceof PetDispatchRefusedError || signal.aborted) return;
        throw new Error('Pet Head processing failed: dispatch.');
      }
    }
    // In the running branch, publish an acceptance only after a dispatch receipt.
    if (await publishReply(message, decision.reply, signal, decision.delivery ? undefined : current)) {
      throw new Error('Pet Head processing failed: reply.');
    }
  }

  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    // Automated Head replies stay in the Timeline but never trigger another Head.
    if (message.author.kind === 'pet' && message.replyTo &&
      message.externalRef === `head-reply:${message.replyTo}`) return;
    // Stage 1: check relevance from public Channel context, never execution state.
    const context = await options.channel.readContext(options.pet.petId, message.sequence, message.replyTo);
    if (signal.aborted) return;
    const base = { pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context };
    const input = { ...base, addressed: isHeadAddressed(base) };
    if (!input.addressed && !(await options.assessRelevance(input, signal)).relevant) return;
    // Stage 2: resolve Session evidence, decide handling and apply verified effects.
    if (!signal.aborted) await handleRelevantMessage(input, signal);
  };
}
