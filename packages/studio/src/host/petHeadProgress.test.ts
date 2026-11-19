import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import type { StudioDispatchQueue, StudioEventHandler } from '../studioContract';
import type { HeadContext, HeadMessage } from './petHead';
import { observePetHeadDispatches } from './petHeadDispatch';
import { answerHeadProgress, type HeadProgressIntent } from './petHeadProgress';

const petId = 'worker-1';
const channelId = 'team';
const sessionId = 'channel-session';
const invocationId = 'studio-invocation';
const requestId = 'host-1';
const source: HeadMessage = {
  sequence: 1, messageId: 'source', channelId, author: { kind: 'human', id: 'local' },
  occurredAt: '2026-01-01T00:00:00Z', mentions: [], body: 'Do the work',
};
const question: HeadMessage = { ...source, sequence: 2, messageId: 'question', body: 'What is the status?', replyTo: source.messageId };
const context: HeadContext = {
  messages: [source, question], members: [{ id: petId, kind: 'pet', participantId: `pet:${petId}` }], referencedMessage: source,
};

async function fixture() {
  const controller = new AbortController();
  let handler!: StudioEventHandler;
  let eventId = 0;
  const knowledge = observePetHeadDispatches({ petId, channelId, definitionId: 'worker', name: 'Worker', createdAt: source.occurredAt },
    next => { handler = next; return () => {}; }, controller.signal);
  const receipt = Promise.resolve({ petId, invocationId });
  knowledge.track(source.messageId, { invocationId, receipt });
  await receipt;
  function emit(phase: string, info: Record<string, unknown> = {}, occurredAt = new Date().toISOString()) {
    return handler({
      eventId: `event-${eventId++}`, occurredAt, type: `dispatch.${phase}`, source: 'resident-pet', topic: petId,
      payload: { petId, scope: { namespace: 'channel', id: channelId }, invocationId, sessionId, ...info },
    });
  }
  const answer = (options: {
    intent?: HeadProgressIntent; readQueues?: () => StudioDispatchQueue[];
    readProgressSession?: NonNullable<Parameters<typeof answerHeadProgress>[0]['channel']['readProgressSession']>;
  } = {}) => answerHeadProgress({
    petId, message: question, context, knowledge, signal: controller.signal,
    intent: options.intent ?? 'progress-status', readQueues: options.readQueues,
    channel: { readContext: async () => context, readProgressSession: options.readProgressSession },
  });
  return { emit, answer, controller };
}

test('stale progress corroborates only an exact queue entry; a different origin or conversation does not settle it', async () => {
  const f = await fixture();
  await f.emit('queued', {}, source.occurredAt);
  const entry = { dispatchId: invocationId, sessionId, enqueuedAt: source.occurredAt,
    scope: { namespace: 'channel', id: channelId }, origin: { namespace: 'channel', id: source.messageId } };
  let reads = 0;
  const queue: StudioDispatchQueue = {
    petId, state: 'busy', activeOperation: 'dispatch', activeDispatch: entry, queuedConversations: 0, queuedDispatches: 0,
  };
  const options = { readQueues: () => { reads++; return [queue]; } };
  assert.match((await f.answer(options))!, /is running/u);
  queue.activeOperation = 'conversation';
  assert.match((await f.answer(options))!, /can’t confirm.*Last observed.*queued/u);
  queue.activeOperation = 'dispatch';
  queue.activeDispatch = { ...entry, origin: { namespace: 'channel', id: 'foreign-source' } };
  assert.match((await f.answer(options))!, /can’t confirm.*Last observed.*queued/u);
  assert.equal(reads, 3);
});

test('an unavailable detail snapshot preserves fresh live evidence; an exact different request is a contradiction', async () => {
  const f = await fixture();
  await f.emit('running', { requestId });
  const unavailable = await f.answer({
    intent: 'progress-details',
    readProgressSession: async (pet, session) => {
      assert.deepEqual([pet, session], [petId, sessionId]);
      throw new Error('private outage detail');
    },
  });
  assert.match(unavailable!, /is running.*can’t confirm the specific step/u);
  assert.doesNotMatch(unavailable!, /private outage detail/u);

  const contradiction = await f.answer({
    intent: 'progress-details',
    readProgressSession: async () => createAgentSessionSnapshot({
      sessionId, kind: 'chat', timeline: [], pendingInterrupt: null,
      activeRun: { requestId: 'different-request', state: 'running', activity: 'thinking' },
      currentPlan: { items: [{ id: 'another', capability: 'hidden', task: 'secret', status: 'active' }] },
    }),
  });
  assert.match(contradiction!, /can’t confirm.*Last observed.*running/u);
  assert.doesNotMatch(contradiction!, /different-request|another|hidden|secret/u);
});

test('new live evidence wins over a snapshot in flight; no fallback reads and abort cancels an answer', async () => {
  const f = await fixture();
  await f.emit('running', { requestId }, source.occurredAt);
  let sessionReads = 0;
  const answer = await f.answer({
    intent: 'progress-details',
    readQueues: () => { assert.fail('once Session is selected, do not read queue'); },
    readProgressSession: async () => {
      sessionReads++;
      await f.emit('waiting', { requestId, pendingInterrupt: { interruptId: 'review', payload: { kind: 'human_review' } } });
      return createAgentSessionSnapshot({
        sessionId, kind: 'chat', timeline: [], pendingInterrupt: null,
        activeRun: { requestId, state: 'running', activity: 'thinking' },
      });
    },
  });
  assert.match(answer!, /waiting for human review/u);
  assert.equal(sessionReads, 1);
  assert.equal(await f.answer({
    intent: 'progress-details',
    readProgressSession: async () => { f.controller.abort(); throw new Error('closed'); },
  }), undefined);
});
