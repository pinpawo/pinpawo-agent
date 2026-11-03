import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionSnapshot, type AgentServerMessage } from '@pinpawo/agent-session';
import type { ResidentPetInteraction } from '../residentPetHost';
import { startResidentPetAgentSessionTransport } from './agentSessionRoute';

test('HTTP authenticates, validates messages and streams without connecting an interactive peer', async () => {
  const listeners = new Set<(message: AgentServerMessage) => void>();
  const received: unknown[] = [];
  let release!: () => void;
  let completed = false;
  const interaction: ResidentPetInteraction = {
    connect: () => { throw new Error('TUI already connected'); },
    disconnect: () => { throw new Error('Must not disconnect TUI'); },
    handle: async () => { throw new Error('Must not use interactive handle'); },
    close: async () => undefined,
    snapshot: async () => ({
      type: 'session.snapshot.result', requestId: 'snapshot',
      snapshot: createAgentSessionSnapshot({ sessionId: 'executor:1', kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null }),
    }),
    getQueueSnapshot: () => ({ state: 'waiting', activeOperation: null, queuedConversations: 0, queuedDispatches: 1 }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request: async (message) => {
      received.push(message);
      for (const listener of listeners) listener({ type: 'pong' });
      await new Promise<void>((resolve) => { release = resolve; });
      completed = true;
    },
  };
  const transport = await startResidentPetAgentSessionTransport(0, new Map([['executor', interaction]]), {
    authToken: 'test-token', log: () => undefined,
  });
  const base = `http://127.0.0.1:${transport.port}/agent-session/pets/executor`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const abort = new AbortController();
  try {
    assert.equal((await fetch(`${base}/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/messages`, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    const snapshotResponse = await fetch(`${base}/snapshot`, { headers });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { queue: { state: string } };
    assert.equal(snapshot.queue.state, 'waiting');
    const stream = await fetch(`${base}/events`, { headers, signal: abort.signal });
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    await reader.read(); // Connected comment: subscription is ready.
    const command = { type: 'interrupt.resume', requestId: 'review-1', interruptId: 'interrupt-1', value: { decisions: [] } };
    const response = await fetch(`${base}/messages`, { method: 'POST', headers, body: JSON.stringify(command) });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { requestId: 'review-1' });
    assert.deepEqual(received, [command]);
    assert.equal(completed, false);
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: message\ndata: \{"type":"pong"\}/);
    abort.abort();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, true);
    assert.equal(listeners.size, 0);
  } finally {
    abort.abort();
    release?.();
    transport.close();
    await transport.closed;
  }
});

test('HTTP refuses the requester-only address RPC before dispatch, address lookup or shared SSE output', async () => {
  const listeners = new Set<(message: AgentServerMessage) => void>();
  let didUnsubscribe!: () => void;
  const unsubscribed = new Promise<void>(resolve => { didUnsubscribe = resolve; });
  let requests = 0;
  let addressLookups = 0;
  const interaction = {
    request: async () => {
      requests += 1;
      for (const listener of listeners) listener({ type: 'artifact.address.result', requestId: 'address',
        uri: 'artifact://workspace/session/object/report.txt', address: 'https://objects.example.test/?signature=private' });
    },
    subscribe: (listener: (message: AgentServerMessage) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); didUnsubscribe(); };
    },
  } as unknown as ResidentPetInteraction;
  const transport = await startResidentPetAgentSessionTransport(0, new Map([['executor', interaction]]), {
    authToken: 'test-token', log: () => undefined,
    fetchArtifact: async () => { addressLookups += 1; throw new Error('Must not look up an address.'); },
  });
  const controller = new AbortController();
  const base = `http://127.0.0.1:${transport.port}/agent-session/pets/executor`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  try {
    const stream = await fetch(`${base}/events`, { headers, signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    const pending = reader.read().then(value => ({ kind: 'data', value }), () => ({ kind: 'aborted' }));
    const response = await fetch(`${base}/messages`, { method: 'POST', headers,
      body: JSON.stringify({ type: 'artifact.address.get', requestId: 'address', uri: 'artifact://workspace/session/object/report.txt' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /GET \/agent-session\/artifacts/);
    assert.equal(requests, 0, 'the query must never reach the Host peer or session history');
    assert.equal(addressLookups, 0);
    const result = await Promise.race([pending, new Promise<{ kind: string }>(resolve => setTimeout(() => resolve({ kind: 'silent' }), 25))]);
    assert.equal(result.kind, 'silent', 'the observer must not receive the requester-only response');
  } finally {
    controller.abort();
    transport.close();
    await transport.closed;
    await unsubscribed;
  }
  assert.equal(listeners.size, 0);
});
