import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sendLocalServerPeerEvent,
  type LocalServerPeer,
} from './localServerPeer';

test('local server peers preserve trusted event payloads by default', () => {
  const sent: unknown[] = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };

  assert.equal(sendLocalServerPeerEvent(peer, {
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: {
      kind: 'read_file',
      target: '/Users/alice/project/private.txt',
    },
    raw: {
      input: { path: '/Users/alice/project/private.txt' },
    },
  }), true);
  assert.equal(sendLocalServerPeerEvent(peer, {
    type: 'message.delta',
    requestId: 'req-1',
    messageId: 'm-1',
    role: 'assistant',
    text: 'Saved to /Users/alice/project/private.txt',
  }), true);
  assert.deepEqual(sent, [
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'completed',
        operation: {
          kind: 'read_file',
          target: '/Users/alice/project/private.txt',
        },
        raw: {
          input: { path: '/Users/alice/project/private.txt' },
        },
      },
    },
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.delta',
        requestId: 'req-1',
        messageId: 'm-1',
        role: 'assistant',
        text: 'Saved to /Users/alice/project/private.txt',
      },
    },
  ]);
});
