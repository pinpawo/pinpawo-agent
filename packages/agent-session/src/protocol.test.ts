import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_LOCAL_ATTACHMENT_LIMIT,
  createAgentSessionSnapshot,
  parseAgentClientMessage,
  parseAgentServerMessage,
} from './index';

test('chat request parser accepts bounded local path attachments', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '',
    activeDelegationTransition: 'resume_active',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/tmp/spec.md',
      name: 'spec.md',
    }],
  }), {
    type: 'chat_request',
    requestId: 'request-1',
    message: '',
    activeDelegationTransition: 'resume_active',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/tmp/spec.md',
      name: 'spec.md',
    }],
  });
});

test('chat request parser rejects relative, duplicate, and excessive attachments', () => {
  const attachment = {
    id: 'attachment-1',
    source: 'local-path',
    kind: 'file',
    path: '/tmp/spec.md',
    name: 'spec.md',
  } as const;
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: [{ ...attachment, path: 'relative/spec.md' }],
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: [attachment, { ...attachment }],
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: Array.from(
      { length: AGENT_LOCAL_ATTACHMENT_LIMIT + 1 },
      (_, index) => ({
        ...attachment,
        id: `attachment-${index}`,
        path: `/tmp/spec-${index}.md`,
      }),
    ),
  }), null);
});

test('runtime config protocol supports legacy updates and correlated acknowledgements', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'require_authorization',
  }), {
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'require_authorization',
  });
  assert.deepEqual(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  }), {
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  });
  assert.equal(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: 'policy-invalid-level',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'balanced',
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: 42,
    globalReviewPolicyMode: 'auto_authorization',
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: '',
    globalReviewPolicyMode: 'auto_authorization',
  }), null);
  assert.deepEqual(parseAgentServerMessage({
    type: 'runtime_config.result',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  }), {
    type: 'runtime_config.result',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  });
  assert.deepEqual(parseAgentServerMessage({
    type: 'runtime_config.error',
    requestId: 'policy-2',
    message: 'config is read-only',
  }), {
    type: 'runtime_config.error',
    requestId: 'policy-2',
    message: 'config is read-only',
  });
});

test('runtime run boundaries round-trip for observing clients', () => {
  const started = {
    type: 'event' as const,
    requestId: 'host-run-1',
    event: {
      type: 'run.started' as const,
      requestId: 'host-run-1',
      initiator: 'host' as const,
      input: { role: 'user' as const, text: 'inspect the queue' },
    },
  };
  assert.deepEqual(parseAgentServerMessage(started), started);

  const interrupted = {
    type: 'event' as const,
    requestId: 'host-run-1',
    event: {
      type: 'run.interrupted' as const,
      requestId: 'host-run-1',
      message: 'Run interrupted.',
    },
  };
  assert.deepEqual(parseAgentServerMessage(interrupted), interrupted);
});

test('session compaction protocol is correlated and snapshot-backed', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'session.compact',
    requestId: 'compact-1',
    sessionId: 'session-1',
  }), {
    type: 'session.compact',
    requestId: 'compact-1',
    sessionId: 'session-1',
  });
  assert.equal(parseAgentClientMessage({
    type: 'session.compact',
    requestId: 'compact-1',
    sessionId: 'session-1',
    extra: true,
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'session.compact',
    requestId: 'compact-1',
  }), null);

  const snapshot = createAgentSessionSnapshot({
    sessionId: 'session-1',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    pendingInterrupt: null,
  });
  assert.deepEqual(parseAgentServerMessage({
    type: 'session.compact.result',
    requestId: 'compact-1',
    compacted: true,
    snapshot,
  }), {
    type: 'session.compact.result',
    requestId: 'compact-1',
    compacted: true,
    snapshot,
  });
});

test('model protocol accepts correlated selection messages and sanitized profile lists', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'model.list',
    requestId: 'models-1',
    sessionId: 'session-1',
  }), {
    type: 'model.list',
    requestId: 'models-1',
    sessionId: 'session-1',
  });
  assert.deepEqual(parseAgentClientMessage({
    type: 'model.select',
    requestId: 'select-1',
    sessionId: 'session-1',
    modelProfileId: 'vision',
  }), {
    type: 'model.select',
    requestId: 'select-1',
    sessionId: 'session-1',
    modelProfileId: 'vision',
  });
  assert.equal(parseAgentClientMessage({
    type: 'model.select',
    requestId: 'select-1',
    sessionId: 'session-1',
    modelProfileId: '',
  }), null);

  const list = {
    type: 'model.list.result',
    requestId: 'models-1',
    sessionId: 'session-1',
    defaultProfileId: 'vision',
    selectedProfileId: 'vision',
    requiredInputModalities: ['text', 'image'],
    profiles: [{
      id: 'vision',
      label: 'Vision',
      provider: 'openai',
      model: 'vision-model',
      endpointHost: 'models.example.test',
      contextWindowTokens: 64_000,
      inputModalities: ['text', 'image'],
      available: true,
      compatible: true,
      issues: [],
    }],
  };
  assert.deepEqual(parseAgentServerMessage(list), list);
  assert.equal(parseAgentServerMessage({
    ...list,
    profiles: [{
      ...list.profiles[0],
      apiKey: 'must-never-be-accepted',
    }],
  }), null);
  assert.deepEqual(parseAgentServerMessage({
    type: 'model.select.error',
    requestId: 'select-2',
    sessionId: 'session-1',
    modelProfileId: 'text',
    code: 'profile_incompatible',
    message: 'session requires image input',
  }), {
    type: 'model.select.error',
    requestId: 'select-2',
    sessionId: 'session-1',
    modelProfileId: 'text',
    code: 'profile_incompatible',
    message: 'session requires image input',
  });
  assert.deepEqual(parseAgentServerMessage({
    type: 'model.select.error',
    requestId: 'select-3',
    sessionId: 'session-1',
    modelProfileId: 'vision',
    code: 'selection_failed',
    message: 'checkpoint unavailable',
  }), {
    type: 'model.select.error',
    requestId: 'select-3',
    sessionId: 'session-1',
    modelProfileId: 'vision',
    code: 'selection_failed',
    message: 'checkpoint unavailable',
  });

  const snapshot = createAgentSessionSnapshot({
    sessionId: 'session-1',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    pendingInterrupt: null,
    runtime: {
      modelProfileId: 'vision',
      modelProfileLabel: 'Vision',
      modelProfileAvailable: true,
      modelProfileIssues: [],
      model: 'vision-model',
      inputModalities: ['text', 'image'],
    },
  });
  const selected = {
    type: 'model.select.result',
    requestId: 'select-1',
    sessionId: 'session-1',
    selectedProfileId: 'vision',
    snapshot,
  };
  assert.deepEqual(parseAgentServerMessage(selected), selected);
  assert.equal(parseAgentServerMessage({
    ...selected,
    selectedProfileId: 'text',
  }), null);
});

test('chat_request accepts an explicit active delegation transition', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'resume_active',
  }), {
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'resume_active',
  });
});

test('chat_request rejects an unknown active delegation transition', () => {
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'guess_from_text',
  }), null);
});
