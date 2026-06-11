import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalAgentClientMessage,
  parseLocalAgentServerMessage,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import type { LocalAgentOperationInternalEvent } from './events/localAgentEvent';

test('parseLocalAgentClientMessage accepts valid chat requests and rejects malformed payloads', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
      userId: 'user-1',
    })),
    {
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
      petId: undefined,
      userId: 'user-1',
    },
  );
  assert.equal(parseLocalAgentClientMessage('{bad json'), null);
  assert.equal(parseLocalAgentClientMessage(JSON.stringify({ type: 'chat_request', message: 'missing request' })), null);
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'chat_request',
      requestId: 'req-1',
      message: 'Approve',
      resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
    })),
    null,
  );
});

test('parseLocalAgentClientMessage accepts canonical human review response fields', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'list files first' },
    })),
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'list files first' },
    },
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      selectedOptionId: 'respond',
      input: { message: 'missing review id' },
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      message: '批准',
      resume: { decisions: [{ type: 'approve' }] },
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      originSessionId: 'session-1',
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: 'not-an-object',
    })),
    null,
  );
  assert.equal(parseLocalAgentClientMessage(JSON.stringify({ type: 'human_review_response', requestId: 'req-1' })), null);
});

test('parseLocalAgentServerMessage rejects legacy server messages by default', () => {
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      input: '{"path":"README.md"}',
    })),
    null,
  );
});

test('parseLocalAgentServerMessage accepts typed local-agent event messages and preserves raw when present', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'started',
        operation: {
          kind: 'bash.read_file',
          title: '读文件',
          target: 'README.md',
          source: {
            provider: 'toolkit',
            name: 'bash',
            toolName: 'read_file',
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
          kind: 'bash.read_file',
          title: '读文件',
          target: 'README.md',
          summary: undefined,
          details: undefined,
          source: {
            provider: 'toolkit',
            name: 'bash',
            toolName: 'read_file',
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

test('parseLocalAgentServerMessage keeps usage on message.completed event when valid', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.completed',
        requestId: 'req-1',
        role: 'assistant',
        text: 'done',
        usage: {
          inputTokens: 10,
          outputTokens: 90,
          totalTokens: 100,
          contextWindow: 2000,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.completed',
        requestId: 'req-1',
        role: 'assistant',
        text: 'done',
        usage: {
          inputTokens: 10,
          outputTokens: 90,
          totalTokens: 100,
          contextWindow: 2000,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  );
});

test('parseLocalAgentServerMessage accepts subagent message delta events', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.delta',
        requestId: 'req-1',
        text: 'subagent output',
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.delta',
        requestId: 'req-1',
        text: 'subagent output',
      },
    },
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.delta',
        requestId: 'other',
        text: 'wrong route',
      },
    })),
    null,
  );
});

test('parseLocalAgentServerMessage accepts canonical human_review.requested review specs', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'human_review.requested',
        requestId: 'req-1',
        review: {
          id: 'review-1',
          schemaVersion: 1,
          view: {
            kind: 'plain',
            title: 'Needs approval',
            body: 'Run command?',
          },
          options: [{
            id: 'approve',
            label: 'Approve',
            decision: { type: 'approve' },
          }],
        },
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'human_review.requested',
        requestId: 'req-1',
        review: {
          id: 'review-1',
          schemaVersion: 1,
          view: {
            kind: 'plain',
            title: 'Needs approval',
            body: 'Run command?',
          },
          options: [{
            id: 'approve',
            label: 'Approve',
            decision: { type: 'approve' },
          }],
        },
      },
    },
  );
});

test('parseLocalAgentServerMessage rejects legacy human_review.requested fields', () => {
  const canonicalEvent = {
    type: 'human_review.requested',
    requestId: 'req-1',
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: {
        kind: 'plain',
        body: 'Run command?',
      },
      options: [{
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      }],
    },
  };

  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        ...canonicalEvent,
        prompt: 'Run command?',
      },
    })),
    null,
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        ...canonicalEvent,
        payload: { kind: 'review' },
      },
    })),
    null,
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        ...canonicalEvent,
        review: {
          ...canonicalEvent.review,
          options: [{
            id: 'edit',
            label: 'Edit',
            decision: { type: 'edit' },
          }],
        },
      },
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

test('sendLocalAgentEvent strips operation.raw by default (remote-safe)', () => {
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
  }), true);
  const internalOperationEvent: LocalAgentOperationInternalEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      kind: 'bash.read_file',
      title: '读文件',
    },
    raw: {
      input: { path: 'README.md' },
    },
  };
  assert.equal(sendLocalAgentEvent(openWs, internalOperationEvent), true);

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
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'operation',
        requestId: 'req-1',
        phase: 'started',
        operation: {
          kind: 'bash.read_file',
          title: '读文件',
        },
      },
    },
  ]);
});

test('sendLocalAgentEvent forwards operation.raw when includeRaw is true (trusted local transport)', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };
  const event: LocalAgentOperationInternalEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: { kind: 'bash.read_file', title: '读文件' },
    raw: {
      input: { path: 'README.md' },
      output: 'file contents',
    },
  };
  assert.equal(sendLocalAgentEvent(openWs, event, { includeRaw: true }), true);
  assert.deepEqual(JSON.parse(sent[0] ?? '{}'), {
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: { kind: 'bash.read_file', title: '读文件' },
      raw: {
        input: { path: 'README.md' },
        output: 'file contents',
      },
    },
  });
});

test('sendLocalAgentEvent leaves non-operation events untouched regardless of includeRaw', () => {
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
    text: 'hi',
  }, { includeRaw: true }), true);
  assert.deepEqual(JSON.parse(sent[0] ?? '{}'), {
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      role: 'assistant',
      text: 'hi',
    },
  });
});
