import type { StudioDispatchQueue, StudioPetSessions } from '../studioContract';
import type { HeadContext, HeadMessage, PetHeadChannel } from './petHead';
import type { HeadDispatchKnowledge, HeadDispatchPhase, HeadDispatchRecord } from './petHeadDispatch';

export type HeadProgressIntent = 'progress-status' | 'progress-details' | 'progress-mixed' | 'progress-reference';

type ProgressPhase = { phase: HeadDispatchPhase; humanReview?: boolean };
type ProgressAnswer =
  | { kind: 'unknown'; referenceNeeded?: boolean; last?: ProgressPhase & { observedAt: string } }
  | { kind: 'reference' }
  | { kind: 'mixed' }
  | { kind: 'known'; evidence: ProgressPhase; publicationConfirmed: boolean };

type Snapshot = Awaited<ReturnType<StudioPetSessions['snapshot']>>;
export const HEAD_PROGRESS_FRESH_MS = 30_000;

function selectPet(petId: string, message: HeadMessage, context: HeadContext): boolean {
  const pets = (context.members ?? []).filter(member => member.kind === 'pet');
  const addressed = new Set(message.mentions.filter(mention => mention.participantId.startsWith('pet:'))
    .map(mention => mention.participantId));
  if (addressed.size > 1) return false;
  const reference = verifiedReference(message, context);
  const recipient = reference?.author.kind === 'pet' ? reference.author.id : undefined;
  if (addressed.size) return addressed.has(`pet:${petId}`) && (!recipient || recipient === petId);
  if (recipient) return recipient === petId;
  return pets.length === 1 && pets[0]?.id === petId;
}

function verifiedReference(message: HeadMessage, context: HeadContext): HeadMessage | undefined {
  const reference = context.referencedMessage;
  return message.replyTo && reference?.messageId === message.replyTo && reference.channelId === message.channelId
    ? reference : undefined;
}

function fromQueue(queues: StudioDispatchQueue[], petId: string, channelId: string, record: HeadDispatchRecord): ProgressPhase | undefined {
  const queue = queues.find(item => item.petId === petId);
  const matches = (item: NonNullable<StudioDispatchQueue['activeDispatch']>) =>
    item.dispatchId === record.invocationId
    && item.scope?.namespace === 'channel' && item.scope.id === channelId
    && item.origin?.namespace === 'channel' && item.origin.id === record.sourceMessageId
    && (!record.sessionId || record.sessionId === item.sessionId);
  if (queue?.activeOperation === 'dispatch' && queue.activeDispatch && matches(queue.activeDispatch))
    return record.phase === 'waiting' ? undefined : { phase: 'running' };
  if (queue?.entries?.some(matches) && (!record.phase || record.phase === 'queued')) return { phase: 'queued' };
  return undefined;
}

function fromSession(snapshot: Snapshot, record: HeadDispatchRecord): ProgressPhase | 'conflict' | undefined {
  const session = snapshot.session;
  if (!record.sessionId || session.sessionId !== record.sessionId || !record.requestId) return;
  if (session.activeRun) {
    if (session.activeRun.requestId !== record.requestId || record.phase === 'waiting') return 'conflict';
    return session.activeRun.state === 'running' ? { phase: 'running' } : 'conflict';
  }
  if (record.phase === 'waiting' && record.interruptId && session.pendingInterrupt) {
    if (session.pendingInterrupt.interruptId !== record.interruptId) return 'conflict';
    return { phase: 'waiting', humanReview: session.pendingInterrupt.payload.kind === 'human_review' };
  }
  // currentPlan has no verifiable owner; checkpoint entries have no requestId.
  // Reading the owned run never grants access to its raw or uncorrelated details.
  return undefined;
}

function isTerminal(phase?: HeadDispatchPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}

function fromObservation(record: HeadDispatchRecord): ProgressPhase | undefined {
  if (!record.phase || record.incomplete || !record.observedAt) return;
  if (!isTerminal(record.phase) && Date.now() - Date.parse(record.observedAt) > HEAD_PROGRESS_FRESH_MS) return;
  return { phase: record.phase, ...(record.humanReview ? { humanReview: true } : {}) };
}

function unknown(record?: HeadDispatchRecord, referenceNeeded = false): ProgressAnswer {
  return { kind: 'unknown', ...(referenceNeeded ? { referenceNeeded } : {}), ...(record?.phase && record.observedAt
    ? { last: { phase: record.phase, observedAt: record.observedAt, ...(record.humanReview ? { humanReview: true } : {}) } } : {}) };
}

/** Progress consumes observations; it cannot get an execution or write capability. */
export async function answerHeadProgress(input: {
  petId: string;
  message: HeadMessage;
  context: HeadContext;
  channel: Pick<PetHeadChannel, 'readContext' | 'readProgressSession' | 'findCommittedPetOutput'>;
  knowledge: HeadDispatchKnowledge;
  intent: HeadProgressIntent;
  readQueues?: () => StudioDispatchQueue[];
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { petId, message, context, channel, knowledge, intent, signal } = input;
  if (!selectPet(petId, message, context)) return;
  const render = (answer: ProgressAnswer) => renderProgress(answer, intent, /\p{Script=Han}/u.test(message.body));
  if (intent === 'progress-mixed') return render({ kind: 'mixed' });
  if (intent === 'progress-reference') return render({ kind: 'reference' });

  let selected: HeadDispatchRecord | undefined;
  if (message.replyTo) {
    const reference = verifiedReference(message, context);
    if (!reference) return render(unknown(undefined, true));
    let matches = knowledge.source(reference.messageId);
    if (!matches.length && reference.author.kind === 'pet' && reference.author.id === petId
      && reference.replyTo && reference.externalRef === `head-reply:${reference.replyTo}`) {
      // Only a direct, existing Head acknowledgement is a permitted one-hop anchor.
      matches = knowledge.source(reference.replyTo);
      if (matches.length) {
        try {
          const prior = await channel.readContext(petId, message.sequence + 1, reference.replyTo);
          if (signal.aborted) return;
          if (!verifiedReference(reference, prior)) matches = [];
        } catch { matches = []; }
      }
    }
    if (matches.length > 1) return render({ kind: 'reference' });
    selected = matches[0];
  } else {
    const ongoing = knowledge.ongoing();
    if (ongoing.incomplete || ongoing.records.length > 1) return render({ kind: 'reference' });
    selected = ongoing.records[0];
  }
  if (signal.aborted) return;
  if (!selected) return render(unknown(undefined, !!message.replyTo));

  const current = knowledge.byId(selected.invocationId);
  if (!current) return render(unknown());
  const record = current;
  let evidence = fromObservation(record);
  const needsDetails = intent === 'progress-details' && !isTerminal(record.phase);
  const checkSession = !!(record.sessionId && record.requestId && channel.readProgressSession);
  if ((!evidence || needsDetails && checkSession) && !isTerminal(record.phase)) {
    try {
      if (checkSession) {
        const snapshot = await channel.readProgressSession!(petId, record.sessionId!);
        const fact = fromSession(snapshot, record);
        if (fact === 'conflict') evidence = undefined;
        else if (fact) evidence = fact;
      } else if (input.readQueues) {
        evidence = fromQueue(input.readQueues(), petId, message.channelId, record);
      }
    } catch { /* An unavailable detail read does not erase fresh live evidence. */ }
    if (signal.aborted) return;
  }

  const updated = knowledge.byId(record.invocationId);
  if (!updated) return render(unknown());
  if (updated.observedAt !== record.observedAt || updated.phase !== record.phase || updated.requestId !== record.requestId
    || updated.sessionId !== record.sessionId || updated.interruptId !== record.interruptId
    || updated.humanReview !== record.humanReview || updated.incomplete !== record.incomplete) {
    evidence = fromObservation(updated);
  }
  if (!evidence || (!message.replyTo && isTerminal(evidence.phase))) return render(unknown(updated));

  let publicationConfirmed = false;
  if (evidence.phase === 'completed' && updated.agentMessageIds.length) {
    try {
      publicationConfirmed = !!(await channel.findCommittedPetOutput?.(petId, [...updated.agentMessageIds].reverse()));
    } catch { /* The execution fact does not depend on the Timeline reader. */ }
  }
  if (signal.aborted) return;
  return render({ kind: 'known', evidence, publicationConfirmed });
}

function renderProgress(answer: ProgressAnswer, intent: HeadProgressIntent, zh: boolean): string {
  if (answer.kind === 'mixed') return zh
    ? '请把进度询问和新操作分开，并直接回复原任务消息来查询。原任务未因这条消息改变。'
    : 'Please ask about progress and request changes separately. Reply to the original task to check it; this message did not change it.';
  if (answer.kind === 'reference') return zh
    ? '请直接回复你想查的原任务消息，我才能确认是哪一项。'
    : 'Please reply directly to the original task so I can tell which one you mean.';
  const label = (evidence: ProgressPhase) => {
    if (zh) return {
      queued: '在排队', running: '正在执行', waiting: evidence.humanReview ? '在等待人工审核' : '在等待',
      completed: '执行已结束', failed: '执行失败', interrupted: '执行已中断',
    }[evidence.phase];
    return {
      queued: 'queued', running: 'running', waiting: evidence.humanReview ? 'waiting for human review' : 'waiting',
      completed: 'ended', failed: 'failed', interrupted: 'interrupted',
    }[evidence.phase];
  };
  if (answer.kind === 'unknown') {
    const base = zh ? '目前无法确认这项工作的状态。' : 'I can’t confirm the current state of that work.';
    if (!answer.last) return base + (answer.referenceNeeded
      ? (zh ? '请直接回复原任务消息来查询。' : ' Please reply directly to the original task.') : '');
    return zh
      ? `${base}上次记录（${answer.last.observedAt}）：${label(answer.last)}。`
      : `${base} Last observed at ${answer.last.observedAt}: ${label(answer.last)}.`;
  }
  if (answer.evidence.phase === 'completed') return zh
    ? (answer.publicationConfirmed ? '执行已结束，已在本 Channel 留下回复。' : '执行已结束，但尚未确认回复已发到本 Channel。')
    : (answer.publicationConfirmed ? 'The execution ended. A reply was posted in this Channel.'
      : 'The execution ended, but I haven’t confirmed a reply in this Channel.');
  const translated = label(answer.evidence);
  const base = zh
    ? `${translated}。`
    : answer.evidence.phase === 'failed' ? 'The execution failed.' : `The execution is ${translated}.`;
  if (intent !== 'progress-details' || isTerminal(answer.evidence.phase)) return base;
  return base + (zh ? '目前没有可确认的具体步骤。' : ' I can’t confirm the specific step.');
}
