import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalAgentClientMessage,
  parseLocalAgentServerMessage,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import type { LocalAgentOperationEvent } from './events/localAgentRuntimeEvent';

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
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'req-1',
      actionId: 123,
    })),
    null,
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

test('parseLocalAgentClientMessage accepts studio_request with explicit runId', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'studio_request',
      requestId: 'studio-1',
      runId: 'run-100',
      conversationId: 'conv-100',
      userRequest: '做一份季度简报',
    })), {
      type: 'studio_request',
      requestId: 'studio-1',
      runId: 'run-100',
      conversationId: 'conv-100',
      userRequest: '做一份季度简报',
    },
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'studio_request',
      requestId: 'studio-1',
      runId: 1,
      userRequest: 'bad runId',
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'studio_request',
      requestId: 'studio-1',
      userRequest: 'bad extra',
      extra: 'unsupported',
    })),
    null,
  );
});

test('parseLocalAgentClientMessage accepts canonical human review response fields', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      actionId: 'interrupt-1',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'list files first' },
    })),
    {
      type: 'human_review_response',
      requestId: 'req-1',
      actionId: 'interrupt-1',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'list files first' },
    },
  );
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    })),
    {
      type: 'review.cancel',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    },
  );
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'run.interrupt',
      requestId: 'req-1',
    })),
    { type: 'run.interrupt', requestId: 'req-1' },
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'run.interrupt',
      requestId: 'req-1',
      actionId: 'interrupt-1',
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'review.cancel',
      requestId: 'req-1',
    })),
    null,
  );
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-2',
      selectedOptionId: 'approve',
      decisions: [
        { reviewId: 'review-1', selectedOptionId: 'approve' },
        { reviewId: 'review-2', selectedOptionId: 'approve' },
      ],
    })),
    {
      type: 'human_review_response',
      requestId: 'req-1',
      reviewId: 'review-2',
      selectedOptionId: 'approve',
      decisions: [
        { reviewId: 'review-1', selectedOptionId: 'approve' },
        { reviewId: 'review-2', selectedOptionId: 'approve' },
      ],
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

test('parseLocalAgentClientMessage rejects legacy interrupt_request control messages', () => {
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'legacy-review',
      actionId: 'interrupt-legacy',
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'legacy-run',
    })),
    null,
  );
});

test('parseLocalAgentClientMessage accepts runtime config updates for built-in review policy modes', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'auto_authorization',
    })),
    {
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'auto_authorization',
    },
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'custom',
    })),
    null,
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'full_access',
      extra: true,
    })),
    null,
  );
});

test('parseLocalAgentClientMessage accepts explicit session request messages', () => {
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'session.snapshot.get',
      requestId: 'snapshot-1',
    })),
    { type: 'session.snapshot.get', requestId: 'snapshot-1' },
  );
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'session.list',
      requestId: 'sessions-1',
    })),
    { type: 'session.list', requestId: 'sessions-1' },
  );
  assert.deepEqual(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'session.resume',
      requestId: 'resume-1',
      sessionId: 'chat:one',
    })),
    { type: 'session.resume', requestId: 'resume-1', sessionId: 'chat:one' },
  );
  assert.equal(
    parseLocalAgentClientMessage(JSON.stringify({
      type: 'session.resume',
      requestId: 'resume-1',
    })),
    null,
  );
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

test('parseLocalAgentServerMessage accepts session results and validates resumed identity', () => {
  const snapshot = {
    version: 3,
    session: {
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    },
  };
  const session = {
    id: 'chat:one',
    kind: 'chat',
    title: 'One',
    messageCount: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:01:00.000Z',
    active: true,
  };

  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'session.snapshot.result',
      requestId: 'snapshot-1',
      snapshot,
    })),
    { type: 'session.snapshot.result', requestId: 'snapshot-1', snapshot },
  );
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'session.list.result',
      requestId: 'sessions-1',
      sessions: [session],
    })),
    { type: 'session.list.result', requestId: 'sessions-1', sessions: [session] },
  );
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'session.resume.result',
      requestId: 'resume-1',
      session,
      snapshot,
    })),
    { type: 'session.resume.result', requestId: 'resume-1', session, snapshot },
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'session.resume.result',
      requestId: 'resume-1',
      session: { ...session, id: 'chat:other' },
      snapshot,
    })),
    null,
  );
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'session.error',
      requestId: 'resume-1',
      operation: 'resume',
      message: 'session not found',
    })),
    {
      type: 'session.error',
      requestId: 'resume-1',
      operation: 'resume',
      message: 'session not found',
    },
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
          source: 'provider',
          scope: 'run',
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
          source: 'provider',
          scope: 'run',
        },
      },
    },
  );
});

test('parseLocalAgentServerMessage keeps review reconciliation error code', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'error',
        requestId: 'req-1',
        message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
        code: 'review_closed',
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'error',
        requestId: 'req-1',
        message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
        code: 'review_closed',
      },
    },
  );
});

test('parseLocalAgentServerMessage accepts studio_response with scheduler metadata', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      finalDispatchId: 'dispatch-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
    })),
    {
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      reason: undefined,
      workdir: undefined,
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
    },
  );
});

test('parseLocalAgentServerMessage accepts studio_response with finalPetRunId only', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
    })),
    {
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      reason: undefined,
      workdir: undefined,
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
    },
  );
});

test('parseLocalAgentServerMessage accepts studio_response with workdir metadata', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      finalDispatchId: 'dispatch-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      workdir: '/tmp/project/.pinpawo',
      idempotencyKey: 'studio:conv-1:run:run-1',
    })),
    {
      type: 'studio_response',
      requestId: 'req-1',
      outcome: 'done',
      reply: 'all done',
      finalPetRunId: 'pet-run-1',
      reason: undefined,
      workdir: '/tmp/project/.pinpawo',
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
    },
  );
});

test('parseLocalAgentServerMessage accepts completed subagent message events', () => {
  assert.deepEqual(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.completed',
        requestId: 'req-1',
        messageId: 'child-1',
        namespace: ['general:t1', 'model_request:t2'],
        text: 'subagent output',
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.completed',
        requestId: 'req-1',
        messageId: 'child-1',
        namespace: ['general:t1', 'model_request:t2'],
        text: 'subagent output',
      },
    },
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.completed',
        requestId: 'other',
        text: 'wrong route',
      },
    })),
    null,
  );
  assert.equal(
    parseLocalAgentServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'subagent.message.completed',
        requestId: 'req-1',
        namespace: ['general:t1', 42],
        text: 'invalid namespace',
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
  }), true);
  const internalOperationEvent: LocalAgentOperationEvent = {
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
  const event: LocalAgentOperationEvent = {
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
