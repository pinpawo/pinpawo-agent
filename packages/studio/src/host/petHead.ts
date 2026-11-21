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
  channel?: { title: string; description?: string; prompt?: string };
  members?: Array<{ kind: 'human' | 'pet'; id: string; participantId: string; label?: string }>;
  referencedMessage?: HeadMessage;
  [key: string]: unknown;
};
/** The model judges responsibility and independent work, not Session state or routing. */
export type HeadDecision = { action: 'ignore' | 'direct' | 'dispatch' | 'status'; reply?: string | null };
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
  dispatch(petId: string, messageId: string, signal: AbortSignal): Promise<unknown>;
  readProgressSession?: (petId: string, ...args: Parameters<HeadSessionRunReader>) => ReturnType<HeadSessionRunReader>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, messageId: string, signal: AbortSignal): Promise<unknown>;
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
    dispatch: (petId, messageId, signal) => operations.dispatch(channelId, petId, messageId, signal),
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
      readWorkState: () => readHeadWorkState(pet.channelId, input.getQueueSnapshot()),
      progress: {
        readRun: observation.read,
        ...(readProgressSession ? { readSessionRunId: (sessionId, signal, isCurrent) =>
          readProgressSession(pet.petId, sessionId, signal, isCurrent) } : {}),
        compose: model.composeReply,
      },
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
  readWorkState?: () => HeadWorkState;
  progress?: {
    readRun: (active: HeadDispatchRef) => HeadRun | undefined;
    readSessionRunId?: HeadSessionRunReader;
    compose: (input: HeadReplyInput, signal: AbortSignal) => Promise<string>;
  };
  decide: (input: HeadInput, signal: AbortSignal) => Promise<HeadDecision>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    // Pin the ordinary slot and attempt before any await. This is not a Session read.
    const state = options.readWorkState?.();
    const active = state?.kind === 'active' ? state.dispatch : undefined;
    const progress = options.progress;
    const run = active && progress?.readRun(active);
    // The exclusive bound keeps the current message out of its own history.
    const context = await options.channel.readContext(options.pet.petId, message.sequence, message.replyTo);
    if (signal.aborted) return;
    const input = {
      pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context,
    };
    const addressed = isHeadAddressed(input);
    const decision = await options.decide({ ...input, addressed }, signal);
    if (signal.aborted || decision.action === 'ignore') return;

    const failures: string[] = [];
    let reply = decision.action === 'status' ? '' : decision.reply ?? '';
    let stillCurrent: (() => boolean) | undefined;
    const dispatch = decision.action === 'dispatch';
    if ((dispatch || decision.action === 'status') && progress) {
      const idle = state?.kind === 'idle' && options.readWorkState?.().kind === 'idle';
      if (!idle || !dispatch) {
        const isCurrent = () => {
          const now = options.readWorkState?.();
          return !!active && !!run && now?.kind === 'active' && now.dispatch.dispatchId === active.dispatchId &&
            now.dispatch.sessionId === active.sessionId && now.dispatch.messageId === active.messageId &&
            progress.readRun(active)?.requestId === run.requestId;
        };
        // An explicit reference to other work never grants access to the current run.
        const reference = context.referencedMessage;
        const targetsActive = !message.replyTo || message.replyTo === active?.messageId ||
          (!!reference && !!active?.messageId && reference.messageId === message.replyTo && reference.channelId === message.channelId &&
            reference.author.kind === 'pet' && reference.author.id === options.pet.petId &&
            reference.replyTo === active.messageId && reference.externalRef === `head-reply:${active.messageId}`);
        try {
          let evidence = targetsActive && run && progress.readSessionRunId && isCurrent()
            ? await readHeadProgress({ run, signal, isCurrent, readSessionRunId: progress.readSessionRunId })
            : { status: 'unavailable' as const };
          if (signal.aborted) return;
          let source: HeadMessage | undefined;
          const sourceId = active?.messageId;
          if (evidence.status === 'running' && sourceId) {
            const isSource = (candidate: HeadMessage | undefined) =>
              candidate?.messageId === sourceId && candidate.channelId === message.channelId;
            source = isSource(reference) ? reference : context.messages.find(isSource);
            if (!source) {
              // Avoid loading old public work for the first decision. Only a
              // confirmed run needs the exact source to write its status.
              const { referencedMessage } = await options.channel.readContext(options.pet.petId, message.sequence, sourceId);
              if (isSource(referencedMessage)) source = referencedMessage;
            }
            if (signal.aborted) return;
            if (!isCurrent()) evidence = { status: 'unavailable' };
          }
          const statusReply = await progress.compose({ message, evidence,
            ...(evidence.status === 'running' && source ? { source: { messageId: source.messageId, body: source.body } } : {}) }, signal);
          // Work-only messages need no status announcement. Preserve an independent acknowledgement.
          if (statusReply.trim() && (evidence.status !== 'running' || isCurrent())) {
            reply = statusReply;
            if (evidence.status === 'running') stillCurrent = isCurrent;
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
    // Admit the canonical source; Head does not rewrite the work passed to Agent.
    if (dispatch && !signal.aborted) {
      try { await options.channel.dispatch(options.pet.petId, message.messageId, signal); }
      catch { failures.push('dispatch'); }
    }
    if (signal.aborted) throw new Error('Pet Head action aborted.');
    // Do not let a failed publication suppress independent authorized execution,
    // or imply that a successful acknowledgement proves admission succeeded.
    if (failures.length) throw new Error('Pet Head action failed: ' + failures.join(', ') + '.');
  };
}
