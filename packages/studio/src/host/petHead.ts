import { addAbortListener } from 'node:events';
import type { Deliverable } from '@pinpawo/agent-contracts';
import type { PetDispatchExecution, PetDispatchPort, PetSessionPort } from 'pinpawo/host-runtime';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
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
type HeadTaskFact = {
  messageId?: string;
  status: PetDispatchExecution['recent'][number]['state'] | 'running' | 'queued';
};
type ReadSession = (sessionId: string) => Promise<Awaited<ReturnType<PetSessionPort['snapshot']>> | undefined>;
type HeadSession = {
  activeRunState: 'running' | 'interrupting' | null;
  recordedPlan?: Array<{ status: string; description: string }>;
};
export type HeadDispatchInput = HeadInput & { tasks?: HeadTaskFact[]; activeSource?: HeadMessage; session?: HeadSession };

async function readSessionFacts(read: ReadSession, sessionId: string, signal: AbortSignal): Promise<HeadSession | undefined> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
  let listener: Disposable | undefined;
  try {
    const result = await Promise.race([
      new Promise<undefined>(resolve => { listener = addAbortListener(deadline, () => resolve(undefined)); }),
      read(sessionId),
    ]);
    const session = result?.session;
    if (deadline.aborted || session?.sessionId !== sessionId) return;
    return {
      activeRunState: session.activeRun?.state ?? null,
      ...(session.currentPlan ? { recordedPlan: session.currentPlan.items.map(({ task, status }) => ({ status, description: task })) } : {}),
    };
  } catch {
    // A missing Session sample does not change Dispatch facts or admission.
  } finally {
    listener?.[Symbol.dispose]();
  }
}

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
  readMessage?(petId: string, messageId: string): Promise<HeadMessage | undefined>;
};

export type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: HeadReplyOptions): Promise<unknown>;
  dispatch(channelId: string, petId: string, messageId: string, signal: AbortSignal, boundSessionId?: string): Promise<unknown>;
  readBoundSessionId?(channelId: string, petId: string): Promise<string | undefined>;
  readMessage?(channelId: string, petId: string, messageId: string): Promise<HeadMessage | undefined>;
};

/** Bind Channel operations and the Studio live bus to this instance's owner Channel. */
export function bindPetHeadChannel(
  channelId: string,
  operations: PetHeadChannelOperations,
  subscribe: Studio['subscribe'],
): PetHeadChannel {
  const readMessage = operations.readMessage;
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
    ...(readMessage ? { readMessage: (petId: string, messageId: string) => readMessage(channelId, petId, messageId) } : {}),
  };
}

/** Attach the Head to one live Pet; PetInstance owns the signal and calls the disposer. */
export function attachPetHead(input: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannelOperations;
  subscribe: Studio['subscribe'];
  readExecution?: PetDispatchPort['readExecution'];
  readSession?: ReadSession;
  resolveModel: () => StudioModelEndpoint;
  onDiagnostic?: (event: HeadRelevanceDiagnostic) => void;
}, signal: AbortSignal): () => void {
  signal.throwIfAborted();
  const { pet, description, subscribe } = input;
  const channel = bindPetHeadChannel(pet.channelId, input.channel, subscribe);
  const model = createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic });
  const handleMessage = createPetHead({
    pet,
    ...(description ? { description } : {}),
    channel,
    readExecution: input.readExecution,
    readSession: input.readSession,
    assessRelevance: model.assessRelevance,
    decideDispatch: model.decideDispatch,
  });
  return channel.subscribe(message => handleMessage(message, signal));
}

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  readExecution?: PetDispatchPort['readExecution'];
  readSession?: ReadSession;
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
    const execution = boundSessionId
      ? options.readExecution?.({ sessionId: boundSessionId, scope: { namespace: 'channel', id: message.channelId } })
      : undefined;
    if (signal.aborted) return;
    const { active, queued, recent } = execution ?? { queued: [], recent: [] };
    const sourceId = (origin?: { namespace: string; id: string }) => origin?.namespace === 'channel' ? origin.id : undefined;
    const activeId = sourceId(active?.origin);
    const tasks: HeadTaskFact[] = [
      ...(active ? [{ messageId: activeId, status: 'running' as const }] : []),
      ...queued.map(item => ({ messageId: sourceId(item.origin), status: 'queued' as const })),
      ...recent.map(item => ({ messageId: sourceId(item.origin), status: item.state })),
    ];
    const session = active && boundSessionId && options.readSession
      ? await readSessionFacts(options.readSession, boundSessionId, signal) : undefined;
    if (signal.aborted) return;
    let activeSource: HeadMessage | undefined;
    if (activeId && activeId !== message.messageId && !context.messages.some(source => source.messageId === activeId)
      && context.referencedMessage?.messageId !== activeId && options.channel.readMessage) {
      try {
        const source = await options.channel.readMessage(options.pet.petId, activeId);
        if (source?.channelId === message.channelId && source.messageId === activeId && source.sequence < message.sequence) activeSource = source;
      } catch {
        // Missing source text does not invalidate execution facts.
      }
    }
    if (signal.aborted) return;
    const decision = await options.decideDispatch({ ...input, ...(tasks.length ? { tasks } : {}),
      ...(activeSource ? { activeSource } : {}), ...(session ? { session } : {}) }, signal);
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
