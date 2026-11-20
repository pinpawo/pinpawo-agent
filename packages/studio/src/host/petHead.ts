import type { Deliverable } from '@pinpawo/agent-contracts';
import type { Studio, StudioDispatchQueue } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { readHeadProgress, type HeadRunReader, type HeadProgressEvidence, type HeadProgressSnapshotReader } from './petHeadProgress';

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
export type HeadSchedulingSnapshot = { active?: HeadDispatchRef; pending: HeadDispatchRef[] };

/** Project only exact sources owned by this Channel. No authority comes from model text. */
export function readHeadDispatchQueueSnapshot(petId: string, channelId: string, queues: StudioDispatchQueue[]): HeadSchedulingSnapshot {
  const queue = queues.find(item => item.petId === petId);
  const project = (item: NonNullable<StudioDispatchQueue['activeDispatch']>): HeadDispatchRef | undefined =>
    item.sessionId && item.scope?.namespace === 'channel' && item.scope.id === channelId
      ? { dispatchId: item.dispatchId, sessionId: item.sessionId, ...(item.origin?.namespace === 'channel' ? { messageId: item.origin.id } : {}) } : undefined;
  const active = queue?.activeOperation === 'dispatch' && queue.activeDispatch && project(queue.activeDispatch);
  return { ...(active ? { active } : {}), pending: (queue?.entries ?? []).flatMap(item => { const ref = project(item); return ref?.messageId ? [ref] : []; }) };
}
export type HeadInput = { pet: StudioPetRegistration; description?: string; message: HeadMessage; context: HeadContext; addressed?: boolean; scheduling?: HeadSchedulingSnapshot; activeSource?: HeadMessage };

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
  readProgressSession?: (petId: string, ...args: Parameters<HeadProgressSnapshotReader>) => ReturnType<HeadProgressSnapshotReader>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, message: HeadMessage, request: string, signal: AbortSignal): Promise<unknown>;
  readProgressSession?: (channelId: string, ...args: Parameters<NonNullable<PetHeadChannel['readProgressSession']>>) => ReturnType<HeadProgressSnapshotReader>;
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

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readScheduling?: () => HeadSchedulingSnapshot;
  progress?: {
    readRun: HeadRunReader;
    snapshot: HeadProgressSnapshotReader;
    compose: (input: { message: HeadMessage; evidence: HeadProgressEvidence }, signal: AbortSignal) => Promise<string>;
  };
  decide: (input: HeadInput, signal: AbortSignal) => Promise<HeadDecision>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    const context = await options.channel.readContext(options.pet.petId, message.sequence + 1, message.replyTo);
    if (signal.aborted) return;
    const scheduling = options.readScheduling?.();
    // Pin the exact invocation AND its current Host run before asking the model.
    // A later observation cannot silently retarget this turn.
    const progress = options.progress;
    const active = scheduling?.active;
    const run = active && progress?.readRun(active);
    // Read the actual active source even if it has aged out of the 50-message
    // context window. Keep source content separate from trusted runtime refs.
    let activeSource: HeadMessage | undefined;
    if (scheduling?.active?.messageId) {
      const sourceId = scheduling.active.messageId;
      activeSource = context.messages.find(item => item.messageId === sourceId && item.channelId === message.channelId);
      if (!activeSource) {
        const lookup = await options.channel.readContext(options.pet.petId, message.sequence + 1, sourceId);
        const candidate = lookup.referencedMessage;
        if (candidate?.messageId === sourceId && candidate.channelId === message.channelId) activeSource = candidate;
      }
    }
    if (signal.aborted) return;
    const input = { ...(scheduling ? { scheduling } : {}), ...(activeSource ? { activeSource } : {}),
      pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context };
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
          const now = options.readScheduling?.().active;
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
            ? await readHeadProgress({ active, run, context, signal, isCurrent, snapshot: progress.snapshot, petId: options.pet.petId, channelId: message.channelId })
            : { status: 'unavailable' as const };
          if (signal.aborted) return;
          reply = await progress.compose({ message, evidence }, signal);
          // The model may have been composing while the next run started.
          // Never publish text based on a run that is no longer current.
          if (evidence.status === 'running') {
            stillCurrent = isCurrent;
            if (!isCurrent() || evidence.publishedUpdates?.some(update => update.text.trim() === reply.trim())) reply = '';
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
