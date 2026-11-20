import type { Deliverable } from '@pinpawo/agent-contracts';
import type { PetDispatchQueueSnapshot } from 'pinpawo/host-runtime';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { readHeadProgress, type HeadRun, type HeadProgressEvidence, type HeadSessionRunReader } from './petHeadProgress';
import { createHeadModel, type HeadDecisionDiagnostic } from './petHeadModel';

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
  members?: Array<{ kind: 'human' | 'pet'; id: string; participantId: string }>;
  referencedMessage?: HeadMessage;
  [key: string]: unknown;
};
/** Reply publication and execution admission are independent decision axes. */
export type HeadDecision = { action: 'ignore' | 'dispatch'; reply: string; intent: string; engage?: boolean; readProgress?: boolean };
type HeadDispatchRef = { dispatchId: string; sessionId: string; messageId?: string };
/** Read only the owning Pet's ordinary dispatch slot, never its pending queue. */
export function readHeadActiveDispatch(channelId: string, queue: PetDispatchQueueSnapshot): HeadDispatchRef | undefined {
  const entry = queue.activeDispatch;
  if (queue.activeOperation !== 'dispatch' || !entry?.sessionId || entry.scope?.namespace !== 'channel' || entry.scope.id !== channelId) return;
  return { dispatchId: entry.dispatchId, sessionId: entry.sessionId, messageId: entry.origin?.namespace === 'channel' ? entry.origin.id : undefined };
}
export type HeadInput = { pet: StudioPetRegistration; description?: string; message: HeadMessage; context: HeadContext; addressed?: boolean;
  activeWork?: { source?: Pick<HeadMessage, 'messageId' | 'body'> } };

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
  dispatch(petId: string, message: HeadMessage, request: string, signal: AbortSignal): Promise<unknown>;
  readProgressSession?: (petId: string, ...args: Parameters<HeadSessionRunReader>) => ReturnType<HeadSessionRunReader>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, message: HeadMessage, request: string, signal: AbortSignal): Promise<unknown>;
  readProgressSession?: (channelId: string, ...args: Parameters<NonNullable<PetHeadChannel['readProgressSession']>>) => ReturnType<HeadSessionRunReader>;
};

/** Bind Channel operations and the Studio live bus to this instance's owner Channel. */
export function bindPetHeadChannel(
  channelId: string,
  operations: PetHeadChannelOperations,
  subscribe: Studio['subscribe'],
): PetHeadChannel {
  const snapshot = operations.readProgressSession;
  return {
    subscribe: handler => subscribe(async event => {
      if (event.source !== 'channel' || event.topic !== channelId || event.type !== 'channel.message.created') return;
      const message = event.payload as HeadMessage | undefined;
      if (!message || message.channelId !== channelId || !message.author) return;
      await handler(message);
    }, { source: 'channel', topic: channelId }),
    readContext: (petId, before, replyTo) => operations.readContext(channelId, petId, before, replyTo),
    reply: (petId, messageId, body, signal, options) => operations.reply(channelId, petId, messageId, body, signal, options),
    dispatch: (petId, message, request, signal) => operations.dispatch(channelId, petId, message, request, signal),
    ...(snapshot ? { readProgressSession: (...args: Parameters<NonNullable<PetHeadChannel['readProgressSession']>>) => snapshot(channelId, ...args) } : {}),
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
  onDiagnostic?: (event: HeadDecisionDiagnostic) => void;
}, signal: AbortSignal): () => void {
  signal.throwIfAborted();
  const { pet, description, subscribe } = input;
  const channel = bindPetHeadChannel(pet.channelId, input.channel, subscribe);
  const readProgressSession = channel.readProgressSession;
  const model = createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic });
  const observation = observeHeadRun(subscribe, pet.petId, pet.channelId, signal);
  let unsubscribe: () => void;
  try {
    const handleMessage = createPetHead({
      pet,
      ...(description ? { description } : {}),
      channel,
      readActiveDispatch: () => readHeadActiveDispatch(pet.channelId, input.getQueueSnapshot()),
      ...(readProgressSession ? { progress: {
        readRun: observation.read,
        readSessionRunId: (sessionId, signal, isCurrent) => readProgressSession(pet.petId, sessionId, signal, isCurrent),
        compose: model.composeReply,
      } } : {}),
      decide: model.decide,
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

/** Only correlate the live run on this Pet's own topic. Never publish from an event. */
export function observeHeadRun(subscribe: Studio['subscribe'], petId: string, channelId: string, signal: AbortSignal) {
  let current: HeadRun | undefined;
  const unsubscribe = subscribe(event => {
    if (signal.aborted || event.source !== 'resident-pet' || event.topic !== petId) return;
    const payload = event.payload as Partial<{
      petId: string; invocationId: string; sessionId: string; requestId: string;
      scope: { namespace: string; id: string };
    }> | undefined;
    if (!payload || payload.petId !== petId || payload.scope?.namespace !== 'channel' || payload.scope.id !== channelId ||
      typeof payload.invocationId !== 'string' || !payload.invocationId || typeof payload.sessionId !== 'string' || !payload.sessionId ||
      typeof payload.requestId !== 'string' || !payload.requestId) return;
    const { invocationId, sessionId, requestId } = payload;
    const matches = current && current.invocationId === invocationId && current.sessionId === sessionId && current.requestId === requestId;
    if (event.type === 'dispatch.running') {
      current = { invocationId, sessionId, requestId };
    } else if (matches && ['dispatch.waiting', 'dispatch.completed', 'dispatch.failed', 'dispatch.interrupted'].includes(event.type)) {
      current = undefined;
    }
  }, { source: 'resident-pet', topic: petId });
  return {
    close: () => { current = undefined; unsubscribe(); },
    read: (active: HeadDispatchRef) => !signal.aborted && current?.invocationId === active.dispatchId && current.sessionId === active.sessionId
      ? current : undefined,
  };
}

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readActiveDispatch?: () => HeadDispatchRef | undefined;
  progress?: {
    readRun: (active: HeadDispatchRef) => HeadRun | undefined;
    readSessionRunId: HeadSessionRunReader;
    compose: (input: { message: HeadMessage; evidence: HeadProgressEvidence }, signal: AbortSignal) => Promise<string>;
  };
  decide: (input: HeadInput, signal: AbortSignal) => Promise<HeadDecision>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    const context = await options.channel.readContext(options.pet.petId, message.sequence + 1, message.replyTo);
    if (signal.aborted) return;
    // Pin the exact invocation AND its current Host run before asking the model.
    // A later observation cannot silently retarget this turn.
    const progress = options.progress;
    const active = options.readActiveDispatch?.();
    const run = active && progress?.readRun(active);
    let source: HeadMessage | undefined;
    const sourceId = active?.messageId;
    if (sourceId) {
      const matchesSource = (candidate: HeadMessage | undefined) =>
        candidate?.messageId === sourceId && candidate.channelId === message.channelId;
      source = context.messages.find(matchesSource);
      if (!source && matchesSource(context.referencedMessage)) source = context.referencedMessage;
      if (!source) {
        const { referencedMessage } = await options.channel.readContext(options.pet.petId, message.sequence + 1, sourceId);
        if (matchesSource(referencedMessage)) source = referencedMessage;
      }
    }
    if (signal.aborted) return;
    const input = {
      pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context,
      ...(active ? { activeWork: source ? { source: { messageId: source.messageId, body: source.body } } : {} } : {}),
    };
    const addressed = isHeadAddressed(input);
    const decision = await options.decide({ ...input, addressed }, signal);
    if (signal.aborted || (!addressed && decision.engage === false)) return;
    const failures: string[] = [];
    let reply = decision.reply;
    let stillCurrent: (() => boolean) | undefined;
    if (decision.readProgress) {
      reply = '';
      if (progress) {
        const isCurrent = () => {
          const now = options.readActiveDispatch?.();
          return !!active && !!run && now?.dispatchId === active.dispatchId && now.sessionId === active.sessionId &&
            now.messageId === active.messageId && progress.readRun(active)?.requestId === run.requestId;
        };
        // If the user explicitly links another message, don't substitute the
        // current run. A real Head reply to the active source is a valid one-hop anchor.
        const reference = context.referencedMessage;
        const targetsActive = !message.replyTo || message.replyTo === active?.messageId ||
          (!!reference && !!active?.messageId && reference.messageId === message.replyTo && reference.channelId === message.channelId &&
            reference.author.kind === 'pet' && reference.author.id === options.pet.petId &&
            reference.replyTo === active?.messageId && reference.externalRef === `head-reply:${active?.messageId}`);
        try {
          const evidence = targetsActive && active && run && isCurrent()
            ? await readHeadProgress({ run, signal, isCurrent, readSessionRunId: progress.readSessionRunId })
            : { status: 'unavailable' as const };
          if (signal.aborted) return;
          reply = await progress.compose({ message, evidence }, signal);
          // The model may have been composing while the next run started.
          // Never publish text based on a run that is no longer current.
          if (evidence.status === 'running') {
            stillCurrent = isCurrent;
            if (!isCurrent()) reply = '';
          }
        } catch {
          if (!signal.aborted) failures.push('progress reply');
        }
      }
    }
    if (signal.aborted) return;
    if (reply.trim()) {
      try {
        const peer = message.author.kind === 'pet';
        const guard = stillCurrent;
        await options.channel.reply(options.pet.petId, message.messageId, reply, signal, peer || guard ? {
          ...(peer ? { preventPetMentions: true } : {}),
          ...(guard ? { assertCurrent: () => {
            if (!guard()) throw new StaleProgressReply();
          } } : {}),
        } : undefined);
      } catch (error) { if (!(error instanceof StaleProgressReply)) failures.push('reply'); }
    }
    // The only admission is the independent work chosen by the first decision.
    if (decision.action === 'dispatch' && !signal.aborted) {
      try { await options.channel.dispatch(options.pet.petId, message, decision.intent, signal); }
      catch { failures.push('dispatch'); }
    }
    if (signal.aborted) throw new Error('Pet Head action aborted.');
    // Do not let a failed publication suppress independent authorized execution,
    // or imply that a successful acknowledgement proves admission succeeded.
    if (failures.length) throw new Error('Pet Head action failed: ' + failures.join(', ') + '.');
  };
}
