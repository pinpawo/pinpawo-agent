import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalAgentClientMessage,
  parseLocalAgentServerMessage,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';

test('parseLocalAgentClientMessage accepts valid chat requests and rejects malformed payloads', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
      userId: 'user-1',
      resume: { decisions: [{ type: 'approve' }] },
    })),
    {
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
      petId: undefined,
      userId: 'user-1',
      resume: { decisions: [{ type: 'approve' }] },
    },
  );
  assert.equal(parseLocalAgentClientMessage('{bad json'), null);
  assert.equal(parseLocalAgentClientMessage(JSON.stringify({ type: 'chat_request', message: 'missing request' })), null);
});

test('parseLocalAgentClientMessage accepts explicit human review responses', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
    })),
    {
      type: 'human_review_response',
      requestId: 'req-1',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
    },
  );
  assert.equal(parseLocalAgentClientMessage(JSON.stringify({ type: 'human_review_response', requestId: 'req-1' })), null);
});

test('parseLocalAgentServerMessage accepts valid tool logs and rejects malformed payloads', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      input: '{"path":"README.md"}',
    })),
    {
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      toolCallId: undefined,
      input: '{"path":"README.md"}',
      output: undefined,
      error: undefined,
    },
  );
  assert.equal(parseLocalAgentServerMessage(JSON.stringify({ type: 'tool_log', requestId: 'req-1', phase: 'bad', toolName: 'x' })), null);
  assert.equal(parseLocalAgentServerMessage(JSON.stringify({ type: 'chat_token', requestId: 'req-1' })), null);
});

test('parseLocalAgentServerMessage accepts typed local-agent event messages', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'started',
        operation: {
          kind: 'file.read',
          title: '读文件',
          target: 'README.md',
          source: {
            provider: 'toolkit',
            name: 'read_file',
          },
        },
        raw: {
          input: { path: 'README.md' },
        },
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'started',
        operation: {
          id: undefined,
          kind: 'file.read',
          title: '读文件',
          target: 'README.md',
          summary: undefined,
          details: undefined,
          source: {
            provider: 'toolkit',
            name: 'read_file',
            callId: undefined,
          },
        },
        raw: {
          input: { path: 'README.md' },
        },
      },
    },
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: { type: 'operation', requestId: 'other', phase: 'started', operation: { kind: 'x' } },
    })),
    null,
  );
});

test('sendLocalAgentMessage writes only when websocket-like object is open', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };
  const closedWs = {
    readyState: 3,
    send() {
      throw new Error('should not send');
    },
  };

  assert.equal(sendLocalAgentMessage(openWs, { type: 'pong' }), true);
  assert.equal(sendLocalAgentMessage(closedWs, { type: 'pong' }), false);
  assert.deepEqual(sent.map((item) => JSON.parse(item)), [{ type: 'pong' }]);
});

test('sendLocalAgentEvent writes typed events and optional legacy compatibility messages', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendLocalAgentEvent(openWs, {
    type: 'message.delta',
    requestId: 'req-1',
    role: 'assistant',
    text: 'hello',
  }), true);
  assert.equal(sendLocalAgentEvent(openWs, {
    type: 'message.completed',
    requestId: 'req-1',
    role: 'assistant',
    text: 'done',
    metadata: { mood: null, topic: null, tags: [] },
  }, { legacyCompatibility: true }), true);

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
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.completed',
        requestId: 'req-1',
        role: 'assistant',
        text: 'done',
        metadata: { mood: null, topic: null, tags: [] },
      },
    },
    {
      type: 'chat_response',
      requestId: 'req-1',
      message: 'done',
      mood: null,
      topic: null,
      tags: [],
    },
  ]);
});

test('sendLocalAgentMessage emits typed event before legacy compatibility messages', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendLocalAgentMessage(openWs, {
    type: 'chat_token',
    requestId: 'req-1',
    token: 'hello',
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

test('sendLocalAgentMessage does not synthesize generic events for legacy tool_log', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };

  assert.equal(sendLocalAgentMessage(openWs, {
    type: 'tool_log',
    requestId: 'req-1',
    phase: 'start',
    toolName: 'read_file',
    input: '{"path":"README.md"}',
  }), true);

  assert.deepEqual(sent.map((item) => JSON.parse(item)), [
    {
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      input: '{"path":"README.md"}',
    },
  ]);
});
