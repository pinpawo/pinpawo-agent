import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createAgentSessionSnapshot,
  type AgentServerMessage,
  type AgentSession,
  type HumanReviewPendingInterruptProjection,
} from '@pinpawo/agent-session';
import {
  applyPetSessionMessage,
  choosePetSessionReviewOption,
  observePetSession,
  readPetSessionReviewOutcome,
} from '../src/petSession';
import { PetSessionReview, PetSessionTranscript, petSessionRunLabel } from '../src/PetSessionView';
import { ChannelExecutionHistory } from '../src/ChannelPanel';

const target = { petId: 'worker', sessionId: 'worker:0000000b', executionId: 'e-1' };

const review: HumanReviewPendingInterruptProjection = {
  interruptId: 'interrupt-1',
  payload: {
    kind: 'human_review',
    interactions: [
      {
        interactionId: 'first', schemaVersion: 2, view: { kind: 'markdown', title: 'Write file', body: 'Write **a.txt**?' },
        options: [
          { id: 'approve', label: 'Approve', variant: 'primary', batchSubmission: 'defer' },
          { id: 'reject', label: 'Reject', variant: 'danger', batchSubmission: 'immediate', input: { kind: 'text', key: 'message', label: 'Why?' } },
        ],
      },
      {
        interactionId: 'second', schemaVersion: 2, view: { kind: 'diff', patch: '+added\n-removed', target: 'b.txt' },
        options: [{ id: 'approve', label: 'Approve', batchSubmission: 'defer' }],
      },
    ],
  },
};

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: target.sessionId, kind: 'chat', activeRun: null, pendingInterrupt: null,
    timeline: [{ id: 'm1', type: 'message', role: 'assistant', text: 'Saved **reply**', status: 'completed',
      toolCalls: [{ id: 'c1', name: 'delegate_capability', args: { briefing: 'Inspect B.' }, status: 'completed' }] }],
    ...overrides,
  };
}

function snapshotMessage(value: AgentSession): AgentServerMessage {
  return { type: 'session.snapshot.result', requestId: 'first', snapshot: createAgentSessionSnapshot(value) };
}

test('a session is rebuilt from its snapshot and then follows that session\'s events', () => {
  let state = applyPetSessionMessage(null, snapshotMessage(session({ pendingInterrupt: review })), target, 1);
  assert.equal(state?.pendingInterrupt?.interruptId, 'interrupt-1');
  state = applyPetSessionMessage(state, { type: 'event', requestId: 'r', event: { type: 'run.started', requestId: 'r', initiator: 'client' } }, target, 2);
  assert.equal(state?.pendingInterrupt, null);
  assert.equal(state?.activeRun?.requestId, 'r');
  state = applyPetSessionMessage(state, { type: 'event', requestId: 'r', event: { type: 'message.delta', requestId: 'r', messageId: 'x', role: 'assistant', text: 'live' } }, target, 3);
  assert.equal(state?.timeline.length, 2);
  // A reconnect's snapshot replaces whatever was assembled live.
  state = applyPetSessionMessage(state, snapshotMessage(session()), target, 4);
  assert.equal(state?.timeline.length, 1);
  assert.equal(state?.activeRun, null);
  // Events before any snapshot have nothing to apply to.
  assert.equal(applyPetSessionMessage(null, { type: 'event', requestId: 'r', event: { type: 'run.started', requestId: 'r', initiator: 'client' } }, target), null);
});

test('review answers follow the server options: defer collects, immediate sends, input is required', () => {
  const first = choosePetSessionReviewOption({ target, review, draft: null, optionId: 'approve', requestId: 'req-1' });
  assert.equal(first.kind, 'collect');
  assert.ok(first.kind === 'collect');
  const second = choosePetSessionReviewOption({ target, review, draft: first.draft, optionId: 'approve', requestId: 'req-2' });
  assert.deepEqual(second, {
    kind: 'send',
    body: {
      petId: 'worker', sessionId: 'worker:0000000b', requestId: 'req-2', interruptId: 'interrupt-1',
      value: { decisions: [
        { interactionId: 'first', selectedOptionId: 'approve' },
        { interactionId: 'second', selectedOptionId: 'approve' },
      ] },
    },
  });
  assert.equal(choosePetSessionReviewOption({ target, review, draft: null, optionId: 'reject', requestId: 'r' }).kind, 'input-required');
  const rejected = choosePetSessionReviewOption({ target, review, draft: null, optionId: 'reject', inputText: ' no ', requestId: 'r' });
  assert.ok(rejected.kind === 'send');
  assert.deepEqual(rejected.body.value.decisions, [{ interactionId: 'first', selectedOptionId: 'reject', input: { message: 'no' } }]);
  // Answers collected for an older interrupt never leak into a new one.
  const fresh = choosePetSessionReviewOption({ target, review: { ...review, interruptId: 'interrupt-2' }, draft: first.draft, optionId: 'approve', requestId: 'r' });
  assert.equal(fresh.kind, 'collect');
  assert.equal(choosePetSessionReviewOption({ target, review, draft: null, optionId: 'invented', requestId: 'r' }).kind, 'stale');
});

test('only events for the submitted request decide its outcome', () => {
  const started: AgentServerMessage = { type: 'event', requestId: 'req', event: { type: 'run.started', requestId: 'req', initiator: 'client' } };
  const refused: AgentServerMessage = { type: 'event', requestId: 'req', event: { type: 'error', requestId: 'req', message: 'closed', code: 'interrupt_closed' } };
  assert.deepEqual(readPetSessionReviewOutcome(started, 'req'), { kind: 'accepted' });
  assert.deepEqual(readPetSessionReviewOutcome(refused, 'req'), { kind: 'refused', message: 'closed' });
  assert.equal(readPetSessionReviewOutcome(started, 'other'), null);
});

test('an unknown session ends observation with the Host\'s reason instead of retrying', async () => {
  const urls: string[] = [];
  const outcomes: Array<[string, boolean]> = [];
  await observePetSession({
    url: 'http://host', token: 'test-only', target, signal: new AbortController().signal,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: 'Session does not exist for this Pet.' }), { status: 404 });
    },
    onConnected: () => assert.fail('unexpected connection'),
    onDisconnected: (error, retrying) => { outcomes.push([error.message, retrying]); },
    onMessage: () => assert.fail('unexpected message'),
  });
  assert.deepEqual(urls, ['http://host/pet-sessions/events?petId=worker&sessionId=worker%3A0000000b']);
  assert.deepEqual(outcomes, [['SSE failed (404). Session does not exist for this Pet.', false]]);
});

test('the first streamed message is parsed as the session snapshot', async () => {
  const abort = new AbortController();
  const received: AgentServerMessage[] = [];
  const frame = `event: agent.session\ndata: ${JSON.stringify(snapshotMessage(session()))}\n\n`;
  await observePetSession({
    url: 'http://host', token: 'test-only', target, signal: abort.signal,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    } })),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onMessage: (message) => { received.push(message); abort.abort(); },
  });
  assert.equal(received[0]?.type, 'session.snapshot.result');
});

test('the reader renders saved messages and calls, and offers no chat composer', () => {
  const html = renderToStaticMarkup(<PetSessionTranscript session={session()} petName="Worker" />);
  assert.match(html, /<strong>reply<\/strong>/);
  assert.match(html, /Inspect B\./);
  assert.doesNotMatch(html, /<textarea|Send message/);
  assert.equal(petSessionRunLabel(session({ pendingInterrupt: review }), 'live'), 'Waiting for review');
  assert.equal(petSessionRunLabel(session({ activeRun: { requestId: 'r', state: 'running', activity: 'thinking' } }), 'reconnecting'),
    'Status unknown · observation interrupted');
});

test('the current review shows the server view and options, disabled while not live', () => {
  const live = renderToStaticMarkup(<PetSessionReview review={review} draft={null} enabled submission={null} onChoose={() => null} />);
  assert.match(live, /Review 1 of 2/);
  assert.match(live, /<strong>a\.txt<\/strong>/);
  assert.match(live, />Approve<\/button>/);
  assert.match(live, />Reject<\/button>/);
  assert.doesNotMatch(live, /disabled=""/);
  const second = renderToStaticMarkup(<PetSessionReview review={review} enabled submission={null} onChoose={() => null}
    draft={{ interruptId: 'interrupt-1', responses: [{ interactionId: 'first', selectedOptionId: 'approve' }] }} />);
  assert.match(second, /Review 2 of 2/);
  assert.match(second, /class="added">\+added/);
  assert.match(second, /1 earlier answer will be sent together/);
  const offline = renderToStaticMarkup(<PetSessionReview review={review} draft={null} enabled={false} submission={null} onChoose={() => null} />);
  assert.match(offline, /disabled=""/);
  assert.match(offline, /only while the session is observed live/);
});

test('each execution keeps an entry to its own session', () => {
  const execution = { sequence: 1, executionId: 'e-1', channelId: 'a', petId: 'worker', sessionId: 'worker:0000000b',
    state: 'completed' as const, occurredAt: '2026-10-04T00:00:00Z', observationLost: false };
  const html = renderToStaticMarkup(<ChannelExecutionHistory executions={[execution]} connected onViewSession={() => undefined} />);
  assert.match(html, />View session<\/button>/);
});
