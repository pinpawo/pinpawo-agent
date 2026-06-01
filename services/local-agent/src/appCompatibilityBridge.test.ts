import assert from 'node:assert/strict';
import test from 'node:test';
import { sendAppCompatibilityEvent } from './protocol/appCompatibilityBridge';

test('sendAppCompatibilityEvent emits typed event before derived chat legacy message', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendAppCompatibilityEvent(openWs, {
    type: 'message.delta',
    requestId: 'req-1',
    role: 'assistant',
    text: 'hello',
  }), true);

  assert.deepEqual(sent.map((item) => JSON.parse(item)), [
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.delta',
        requestId: 'req-1',
        role: 'assistant',
        text: 'hello',
      },
    },
    {
      type: 'chat_token',
      requestId: 'req-1',
      token: 'hello',
    },
  ]);
});

test('sendAppCompatibilityEvent emits typed event before derived tool legacy message', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendAppCompatibilityEvent(openWs, {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      kind: 'tool.execute',
      title: 'read_file',
      source: {
        provider: 'runtime',
        name: 'read_file',
      },
    },
    raw: {
      input: '{"path":"README.md"}',
    },
  }), true);

  assert.deepEqual(sent.map((item) => JSON.parse(item)), [
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'started',
        operation: {
          kind: 'tool.execute',
          title: 'read_file',
          source: {
            provider: 'runtime',
            name: 'read_file',
          },
        },
        raw: {
          input: '{"path":"README.md"}',
        },
      },
    },
    {
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      input: '{"path":"README.md"}',
    },
  ]);
});
