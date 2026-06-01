import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyToolLogMessage,
  sendLocalAgentCompatibilityEvent,
} from './protocol/legacyProtocolAdapter';

test('buildLegacyToolLogMessage derives legacy tool_log from operation events', () => {
  assert.deepEqual(buildLegacyToolLogMessage({
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: {
      id: 'call-1',
      kind: 'file.write',
      title: '写文件',
      source: {
        provider: 'toolkit',
        name: 'write_file',
        callId: 'call-1',
      },
    },
    raw: {
      input: { path: 'a.txt', content: 'hello' },
      output: { ok: true, path: '/tmp/a.txt' },
    },
  }), {
    type: 'tool_log',
    requestId: 'req-1',
    phase: 'end',
    toolName: 'write_file',
    toolCallId: 'call-1',
    input: 'hello',
    output: '{"ok":true,"path":"/tmp/a.txt"}',
    error: undefined,
  });
});

test('sendLocalAgentCompatibilityEvent emits typed event before derived chat legacy message', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendLocalAgentCompatibilityEvent(openWs, {
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

test('sendLocalAgentCompatibilityEvent emits typed event before derived tool legacy message', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendLocalAgentCompatibilityEvent(openWs, {
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
