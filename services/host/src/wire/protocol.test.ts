import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseHostClientMessage,
  parseHostServerMessage,
  sendHostEvent,
  sendHostMessage,
} from './protocol';
import {
  createAgentSessionSnapshot,
  type AgentSession,
  type AgentOperationEvent,
} from '@pinpawo/agent-session';

test('parseHostClientMessage accepts valid chat requests and rejects malformed payloads', () => {
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
      userId: 'user-1',
    })),
    {
      type: 'chat_request',
      requestId: 'req-1',
      message: 'hello',
    },
  );
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'req-1',
      actionId: 123,
    })),
    null,
  );
  assert.equal(parseHostClientMessage('{bad json'), null);
  assert.equal(parseHostClientMessage(JSON.stringify({ type: 'chat_request', message: 'missing request' })), null);
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'chat_request',
      requestId: 'req-1',
      message: 'Approve',
      resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
    })),
    null,
  );
});

test('parseHostClientMessage accepts a review resume by interrupt id', () => {
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          interactionId: 'review-1',
          selectedOptionId: 'respond',
          input: { message: 'list files first' },
        }],
      },
    })),
    {
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: {
        decisions: [{
          interactionId: 'review-1',
          selectedOptionId: 'respond',
          input: { message: 'list files first' },
        }],
      },
    },
  );
  // Cancelling a review is a resume value too, not a message of its own.
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: { action: 'cancel' },
    })),
    {
      type: 'interrupt.resume',
      requestId: 'req-1',
      interruptId: 'interrupt-1',
      value: { action: 'cancel' },
    },
  );
});

test('parseHostClientMessage rejects legacy interrupt_request control messages', () => {
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'legacy-review',
      actionId: 'interrupt-legacy',
    })),
    null,
  );
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'interrupt_request',
      requestId: 'legacy-run',
    })),
    null,
  );
});

test('parseHostClientMessage accepts runtime config updates for built-in review policy modes', () => {
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'auto_authorization',
    })),
    {
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'auto_authorization',
    },
  );
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'custom',
    })),
    null,
  );
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'runtime_config.update',
      globalReviewPolicyMode: 'full_access',
      extra: true,
    })),
    null,
  );
});

test('parseHostClientMessage accepts explicit session request messages', () => {
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'session.snapshot.get',
      requestId: 'snapshot-1',
    })),
    { type: 'session.snapshot.get', requestId: 'snapshot-1' },
  );
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'session.list',
      requestId: 'sessions-1',
    })),
    { type: 'session.list', requestId: 'sessions-1' },
  );
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'session.new',
      requestId: 'new-1',
    })),
    { type: 'session.new', requestId: 'new-1' },
  );
  assert.deepEqual(
    parseHostClientMessage(JSON.stringify({
      type: 'session.resume',
      requestId: 'resume-1',
      sessionId: 'chat:one',
    })),
    { type: 'session.resume', requestId: 'resume-1', sessionId: 'chat:one' },
  );
  assert.equal(
    parseHostClientMessage(JSON.stringify({
      type: 'session.resume',
      requestId: 'resume-1',
    })),
    null,
  );
});

test('parseHostServerMessage rejects legacy server messages by default', () => {
  assert.equal(
    parseHostServerMessage(JSON.stringify({
      type: 'tool_log',
      requestId: 'req-1',
      phase: 'start',
      toolName: 'read_file',
      input: '{"path":"README.md"}',
    })),
    null,
  );
});

test('parseHostServerMessage accepts session results and validates resumed identity', () => {
  const snapshot = {
    version: 5,
    session: {
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      pendingInterrupt: null,
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
    parseHostServerMessage(JSON.stringify({
      type: 'session.snapshot.result',
      requestId: 'snapshot-1',
      snapshot,
    })),
    { type: 'session.snapshot.result', requestId: 'snapshot-1', snapshot },
  );
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'session.list.result',
      requestId: 'sessions-1',
      sessions: [session],
    })),
    { type: 'session.list.result', requestId: 'sessions-1', sessions: [session] },
  );
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'session.new.result',
      requestId: 'new-1',
      session,
      snapshot,
    })),
    { type: 'session.new.result', requestId: 'new-1', session, snapshot },
  );
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'session.resume.result',
      requestId: 'resume-1',
      session,
      snapshot,
    })),
    { type: 'session.resume.result', requestId: 'resume-1', session, snapshot },
  );
  assert.equal(
    parseHostServerMessage(JSON.stringify({
      type: 'session.resume.result',
      requestId: 'resume-1',
      session: { ...session, id: 'chat:other' },
      snapshot,
    })),
    null,
  );
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'session.error',
      requestId: 'new-1',
      operation: 'new',
      message: 'run is active',
    })),
    {
      type: 'session.error',
      requestId: 'new-1',
      operation: 'new',
      message: 'run is active',
    },
  );
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
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

test('parseHostServerMessage accepts typed host event messages and preserves raw when present', () => {
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
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
    },
  );
  assert.equal(
    parseHostServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: { type: 'operation', requestId: 'other', phase: 'started', operation: { kind: 'x' } },
    })),
    null,
  );
});

test('parseHostServerMessage keeps usage on message.completed event when valid', () => {
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'message.completed',
        requestId: 'req-1',
        messageId: 'm-req-1',
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
        messageId: 'm-req-1',
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

test('parseHostServerMessage keeps review reconciliation error code', () => {
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'error',
        requestId: 'req-1',
        message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
        code: 'interrupt_closed',
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'error',
        requestId: 'req-1',
        message: '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。',
        code: 'interrupt_closed',
      },
    },
  );
});

test('parseHostServerMessage accepts completed subagent message events', () => {
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
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
    parseHostServerMessage(JSON.stringify({
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
    parseHostServerMessage(JSON.stringify({
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

test('parseHostServerMessage accepts public interrupt.requested interactions', () => {
  assert.deepEqual(
    parseHostServerMessage(JSON.stringify({
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'interrupt.requested',
        requestId: 'req-1',
        pendingInterrupt: {
          interruptId: 'interrupt-1',
          payload: {
            kind: 'human_review',
            interactions: [{
              interactionId: 'review-1',
              schemaVersion: 2,
              view: {
                kind: 'plain',
                title: 'Needs approval',
                body: 'Run command?',
              },
              options: [{
                id: 'approve',
                label: 'Approve',
                batchSubmission: 'immediate',
              }],
            }],
          },
        },
      },
    })),
    {
      type: 'event',
      requestId: 'req-1',
      event: {
        type: 'interrupt.requested',
        requestId: 'req-1',
        pendingInterrupt: {
          interruptId: 'interrupt-1',
          payload: {
            kind: 'human_review',
            interactions: [{
              interactionId: 'review-1',
              schemaVersion: 2,
              view: {
                kind: 'plain',
                title: 'Needs approval',
                body: 'Run command?',
              },
              options: [{
                id: 'approve',
                label: 'Approve',
                batchSubmission: 'immediate',
              }],
            }],
          },
        },
      },
    },
  );
});

test('sendHostMessage writes only when websocket-like object is open', () => {
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

  assert.equal(sendHostMessage(openWs, { type: 'pong' }), true);
  assert.equal(sendHostMessage(closedWs, { type: 'pong' }), false);
  assert.deepEqual(sent.map((item) => JSON.parse(item)), [{ type: 'pong' }]);
});

test('completed message text crosses the transport verbatim', () => {
  // app relay 撤除后不再有远端出口:本地对端信任本地路径,
  // 从前只对 remote 生效的路径打码随之移除。
  const sent: string[] = [];
  const openWs = { readyState: 1, send(data: string) { sent.push(data); } };

  assert.equal(sendHostEvent(openWs, {
    type: 'message.completed',
    requestId: 'req-1',
    messageId: 'm-req-1',
    role: 'assistant',
    text: 'Saved to /Users/alice/project/result.txt',
  }), true);

  assert.equal(
    JSON.parse(sent[0] ?? '{}').event.text,
    'Saved to /Users/alice/project/result.txt',
  );
});

test('sendHostEvent forwards operation.raw for trusted local transport', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };
  const event: AgentOperationEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: { kind: 'bash.read_file', title: '读文件' },
    raw: {
      input: { path: 'README.md' },
      output: 'file contents',
    },
  };
  assert.equal(sendHostEvent(openWs, event), true);
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

test('remote event adapter preserves operation display fields and raw payloads', () => {
  const remoteSent: string[] = [];
  const trustedSent: string[] = [];
  const remoteWs = {
    readyState: 1,
    send(data: string) {
      remoteSent.push(data);
    },
  };
  const trustedWs = {
    readyState: 1,
    send(data: string) {
      trustedSent.push(data);
    },
  };
  const event: AgentOperationEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: {
      kind: 'bash.read_file',
      title: '读文件',
      target: '/Users/alice/project/private.txt',
      summary: 'Read /private/tmp/private.txt',
    },
    raw: {
      input: { path: '/Users/alice/project/private.txt' },
    },
  };

  assert.equal(sendHostEvent(remoteWs, event), true);
  assert.equal(sendHostEvent(trustedWs, event), true);

  const remoteEvent = JSON.parse(remoteSent[0] ?? '{}').event;
  assert.deepEqual(remoteEvent.raw, {
    input: { path: '/Users/alice/project/private.txt' },
  });
  assert.equal(remoteEvent.operation.target, '/Users/alice/project/private.txt');
  assert.equal(remoteEvent.operation.summary, 'Read /private/tmp/private.txt');

  const trustedEvent = JSON.parse(trustedSent[0] ?? '{}').event;
  assert.equal(trustedEvent.operation.target, '/Users/alice/project/private.txt');
  assert.deepEqual(trustedEvent.raw, {
    input: { path: '/Users/alice/project/private.txt' },
  });
});

test('remote server-message adapter preserves snapshot payloads', () => {
  const remoteSent: string[] = [];
  const trustedSent: string[] = [];
  const remoteWs = {
    readyState: 1,
    send(data: string) {
      remoteSent.push(data);
    },
  };
  const trustedWs = {
    readyState: 1,
    send(data: string) {
      trustedSent.push(data);
    },
  };
  const session: AgentSession = {
    sessionId: 'session-1',
    kind: 'chat',
    timeline: [{
      id: 'message-1',
      type: 'message',
      role: 'assistant',
      text: 'Saved to /Users/alice/project/result.txt',
      status: 'completed',
    }],
    activeRun: null,
    pendingInterrupt: null,
    runtime: {
      model: 'test-model',
      cwd: '/Users/alice/project',
      workspaceRoot: '/Users/alice/project',
      contextWindow: 100_000,
    },
  };
  const message = {
    type: 'session.snapshot.result' as const,
    requestId: 'snapshot-1',
    snapshot: createAgentSessionSnapshot(session),
  };

  assert.equal(sendHostMessage(remoteWs, message), true);
  assert.equal(sendHostMessage(trustedWs, message), true);

  const remoteSession = JSON.parse(remoteSent[0] ?? '{}').snapshot.session;
  assert.deepEqual(remoteSession.runtime, {
    model: 'test-model',
    cwd: '/Users/alice/project',
    workspaceRoot: '/Users/alice/project',
    contextWindow: 100_000,
  });
  assert.equal(
    remoteSession.timeline[0].text,
    'Saved to /Users/alice/project/result.txt',
  );

  const trustedSession = JSON.parse(trustedSent[0] ?? '{}').snapshot.session;
  assert.equal(trustedSession.runtime.cwd, '/Users/alice/project');
  assert.equal(
    trustedSession.timeline[0].text,
    'Saved to /Users/alice/project/result.txt',
  );
});

test('trusted local event transport preserves streaming message deltas', () => {
  const sent: string[] = [];
  const openWs = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
  };
  assert.equal(sendHostEvent(openWs, {
    type: 'message.delta',
    requestId: 'req-1',
    messageId: 'm-req-1',
    role: 'assistant',
    text: 'hi',
  }), true);
  assert.deepEqual(JSON.parse(sent[0] ?? '{}'), {
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'message.delta',
      requestId: 'req-1',
      messageId: 'm-req-1',
      role: 'assistant',
      text: 'hi',
    },
  });
});
