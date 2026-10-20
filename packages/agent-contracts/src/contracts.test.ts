import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
  isAgentConfig,
  parseAgentInvocationRequest,
  parseAgentStateSnapshot,
  parseAgentWorkCommand,
  parseHumanReviewRequest,
  parseHumanReviewResponse,
  parseTokenUsageSnapshot,
} from './index';

test('configuration accepts only the externally configurable authorization mode', () => {
  assert.equal(isAgentConfig({ toolAuthorization: { mode: 'auto_authorization' } }), true);
  assert.equal(isAgentConfig({
    toolAuthorization: { mode: 'auto_authorization', safetyLevel: 'relaxed' },
  }), true);
  assert.equal(isAgentConfig({
    toolAuthorization: { mode: 'auto_authorization', safetyLevel: 'balanced' },
  }), false);
  assert.equal(isAgentConfig({ toolAuthorization: { mode: 'custom' } }), false);
  assert.equal(isAgentConfig({ toolAuthorization: { mode: 'full_access', resolve: 'internal' } }), false);
});

test('human review boundary excludes runtime decisions and effects', () => {
  const request = {
    interactionId: 'review-1',
    schemaVersion: HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
    view: { kind: 'plain', body: 'Allow this change?' },
    options: [{
      id: 'approve',
      label: 'Allow',
      variant: 'primary',
      batchSubmission: 'defer',
    }],
  } as const;
  assert.deepEqual(parseHumanReviewRequest(request), request);
  assert.equal(parseHumanReviewRequest({
    ...request,
    schemaVersion: HUMAN_REVIEW_REQUEST_SCHEMA_VERSION - 1,
  }), null);
  const operation = {
    ...request,
    view: {
      kind: 'operation',
      title: '执行命令',
      summary: 'npm test',
      target: '/repo',
      details: { level: 'write', paths: ['a.ts'] },
    },
  } as const;
  assert.deepEqual(parseHumanReviewRequest(operation), operation);
  assert.equal(parseHumanReviewRequest({
    ...operation,
    view: { ...operation.view, body: 'npm test' },
  }), null);
  assert.equal(parseHumanReviewRequest({
    ...operation,
    view: { ...operation.view, details: { run: () => undefined } },
  }), null);
  assert.equal(parseHumanReviewRequest({
    ...request,
    options: [{
      ...request.options[0],
      decision: { type: 'approve' },
    }],
  }), null);
  assert.equal(parseHumanReviewRequest({
    ...request,
    options: [{ id: 'approve', label: 'Allow' }],
  }), null);
  assert.equal(parseHumanReviewRequest({
    ...request,
    options: [{
      id: 'approve',
      label: 'Allow',
      batchSubmission: 'later',
    }],
  }), null);
  assert.equal(parseHumanReviewRequest({
    ...request,
    options: [{
      id: 'approve',
      label: 'Allow',
      continuesReviewBatch: true,
    }],
  }), null);
  assert.deepEqual(parseHumanReviewResponse({
    interactionId: 'review-1',
    selectedOptionId: 'approve',
    input: { message: 'yes' },
  }), {
    interactionId: 'review-1',
    selectedOptionId: 'approve',
    input: { message: 'yes' },
  });
});

test('state makes work commands explicit and keeps token usage observational', () => {
  assert.deepEqual(parseAgentWorkCommand({ type: 'resume', workId: 'work-1' }), {
    type: 'resume',
    workId: 'work-1',
  });
  assert.equal(parseAgentWorkCommand({ type: 'supersede_active', workId: 'work-1' }), null);
  assert.equal(parseAgentStateSnapshot({ activeWork: { id: 'old', status: 'paused', resumable: true, cancellable: true } }), null);
  assert.deepEqual(parseAgentStateSnapshot({
    activeWork: {
      id: 'work-1',
      status: 'waiting_interaction',
      resumable: true,
      cancellable: true,
    },
    tokenUsage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, scope: 'run' },
  }), {
    activeWork: {
      id: 'work-1',
      status: 'waiting_interaction',
      resumable: true,
      cancellable: true,
    },
    tokenUsage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, scope: 'run' },
  });
  assert.deepEqual(parseTokenUsageSnapshot({ inputTokens: 8, outputTokens: 3, totalTokens: 11 }), {
    inputTokens: 8,
    outputTokens: 3,
    totalTokens: 11,
  });
});

test('invocation is independent of chat or studio transport envelopes', () => {
  assert.deepEqual(parseAgentInvocationRequest({
    invocationId: 'invoke-1',
    threadId: 'thread-1',
    input: { kind: 'text', text: 'Summarize this' },
  }), {
    invocationId: 'invoke-1',
    threadId: 'thread-1',
    input: { kind: 'text', text: 'Summarize this' },
  });
  assert.equal(parseAgentInvocationRequest({
    invocationId: 'invoke-1',
    input: { kind: 'chat', text: 'not a core input' },
  }), null);
});

test('usage counters and cache coverage reject corrupt snapshots', () => {
  const base = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  for (const invalid of [
    { inputTokens: -1 }, { totalTokens: 0.5 }, { usageRevision: Infinity }, { usageRevision: -1 },
    { usageRevision: Number.MAX_SAFE_INTEGER + 1 }, { cachedInputTokens: 101 },
    { cachedInputTokens: 50, cacheEligibleInputTokens: 40 }, { cacheEligibleInputTokens: 101 },
    { unknownCalls: '1' }, { outputTokensPerSecond: -1 }, { usageEpoch: '' },
  ]) assert.equal(parseTokenUsageSnapshot({ ...base, ...invalid }), null);
});
