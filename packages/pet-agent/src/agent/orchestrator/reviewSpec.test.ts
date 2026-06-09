import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHumanReviewRequest } from './humanReview';
import {
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
} from './review/reviewResponseResolver';
import { buildReviewSpecFromHumanReviewRequest } from './review/reviewSpecFromHumanReview';
import type { PendingReviewState } from './review/reviewSpec';

test('buildReviewSpecFromHumanReviewRequest materializes plain view and V1 options', () => {
  const request = buildHumanReviewRequest({
    actionRequests: [{
      name: 'run_shell',
      args: { command: 'rm -rf tmp', cwd: '/repo' },
      description: 'Delete tmp directory',
    }],
    reviewConfigs: [{
      actionName: 'run_shell',
      allowedDecisions: ['approve', 'edit', 'reject', 'respond'],
      description: 'risky shell command',
    }],
    prompt: 'Approve shell command?',
  });

  const spec = buildReviewSpecFromHumanReviewRequest(request, {
    id: 'review-1',
    title: 'Needs approval',
  });

  assert.equal(spec.id, 'review-1');
  assert.equal(spec.schemaVersion, 1);
  assert.deepEqual(spec.view, {
    kind: 'plain',
    title: 'Needs approval',
    body: 'Approve shell command?\n\nDelete tmp directory',
  });
  assert.deepEqual(
    spec.options.map((option) => ({
      id: option.id,
      label: option.label,
      variant: option.variant,
      input: option.input,
      decision: option.decision,
      effects: option.effects,
    })),
    [
      {
        id: 'approve',
        label: 'Approve',
        variant: 'primary',
        input: undefined,
        decision: { type: 'approve' },
        effects: undefined,
      },
      {
        id: 'reject',
        label: 'Reject',
        variant: 'danger',
        input: undefined,
        decision: { type: 'reject' },
        effects: undefined,
      },
      {
        id: 'respond',
        label: 'Respond',
        variant: undefined,
        input: {
          kind: 'text',
          key: 'message',
          required: true,
          multiline: true,
        },
        decision: { type: 'respond', messageInputKey: 'message' },
        effects: undefined,
      },
    ],
  );
});

test('buildReviewSpecFromHumanReviewRequest includes error and falls back to action names', () => {
  const request = buildHumanReviewRequest({
    actionRequests: [{
      name: 'legacy_action',
      args: { iterationCount: 10 },
    }],
    reviewConfigs: [{
      actionName: 'legacy_action',
      allowedDecisions: ['reject'],
    }],
    error: 'invalid_decision',
  });

  const spec = buildReviewSpecFromHumanReviewRequest(request, { id: 'review-2' });

  assert.equal(spec.view.body, 'Error: invalid_decision\n\nPending action: legacy_action');
  assert.deepEqual(spec.options.map((option) => option.id), ['reject']);
});

test('buildReviewSpecFromHumanReviewRequest defaults decisions when legacy configs are empty', () => {
  const request = buildHumanReviewRequest({
    actionRequests: [],
    reviewConfigs: [],
  });

  const spec = buildReviewSpecFromHumanReviewRequest(request, {
    id: 'review-3',
    schemaVersion: 2,
  });

  assert.equal(spec.schemaVersion, 2);
  assert.equal(spec.view.body, 'This action requires human review.');
  assert.deepEqual(spec.options.map((option) => option.id), ['approve', 'reject', 'respond']);
});

test('buildReviewSpecFromHumanReviewRequest falls back safely when only edit is allowed', () => {
  const request = buildHumanReviewRequest({
    actionRequests: [{
      name: 'git_commit',
      args: { message: 'wip' },
    }],
    reviewConfigs: [{
      actionName: 'git_commit',
      allowedDecisions: ['edit'],
    }],
  });

  const spec = buildReviewSpecFromHumanReviewRequest(request, { id: 'review-4' });

  assert.deepEqual(spec.options.map((option) => option.id), ['reject']);
  assert.deepEqual(spec.options[0]?.decision, { type: 'reject' });
});

function samplePendingReview(): PendingReviewState {
  return {
    requestId: 'req-1',
    reviewSpec: {
      id: 'review-1',
      schemaVersion: 1,
      view: {
        kind: 'plain',
        body: 'Approve shell command?',
      },
      options: [
        {
          id: 'approve',
          label: 'Approve',
          decision: { type: 'approve' },
        },
        {
          id: 'approve-with-auth',
          label: 'Approve and authorize',
          decision: { type: 'approve' },
          effects: [{
            type: 'graph.authorize_tool_action',
            scope: 'thread',
            actionRef: { type: 'pending_action' },
            matcher: { type: 'policy_hook' },
          }],
        },
        {
          id: 'reject',
          label: 'Reject',
          decision: { type: 'reject', message: 'blocked' },
        },
        {
          id: 'respond',
          label: 'Respond',
          input: {
            kind: 'text',
            key: 'message',
            required: true,
            multiline: true,
          },
          decision: { type: 'respond', messageInputKey: 'message' },
        },
      ],
    },
    pendingAction: {
      actionId: 'action-1',
      toolName: 'run_shell',
      args: { command: 'rm -rf tmp' },
    },
  };
}

function assertResolutionError(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) => error instanceof ReviewResponseResolutionError && error.code === code,
  );
}

test('resolveHumanReviewResponse resolves approve option and declared effects', () => {
  const resolution = resolveHumanReviewResponse(samplePendingReview(), {
    reviewId: 'review-1',
    selectedOptionId: 'approve-with-auth',
  });

  assert.deepEqual(resolution, {
    reviewId: 'review-1',
    optionId: 'approve-with-auth',
    decision: { type: 'approve' },
    effects: [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    }],
    display: {
      label: 'Approve and authorize',
    },
  });
});

test('resolveHumanReviewResponse resolves respond input into decision and display', () => {
  const resolution = resolveHumanReviewResponse(samplePendingReview(), {
    reviewId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: 'please list files first' },
  });

  assert.deepEqual(resolution, {
    reviewId: 'review-1',
    optionId: 'respond',
    decision: { type: 'respond', message: 'please list files first' },
    effects: [],
    display: {
      label: 'Respond',
      userInputMessage: 'please list files first',
    },
  });
});

test('resolveHumanReviewResponse rejects stale review responses', () => {
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'old-review',
      selectedOptionId: 'approve',
    }),
    'stale_review',
  );
});

test('resolveHumanReviewResponse rejects unknown options', () => {
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'approve-all',
    }),
    'unknown_option',
  );
});

test('resolveHumanReviewResponse rejects missing respond input', () => {
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'respond',
    }),
    'missing_input',
  );
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: '   ' },
    }),
    'missing_input',
  );
});

test('resolveHumanReviewResponse rejects undeclared input keys', () => {
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      input: { message: 'unexpected' },
    }),
    'unexpected_input',
  );
  assertResolutionError(
    () => resolveHumanReviewResponse(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: {
        message: 'ok',
        extra: true,
      },
    }),
    'unexpected_input',
  );
});

test('resolveHumanReviewResponse rejects authorization effects on non-approve options', () => {
  const pending = samplePendingReview();
  pending.reviewSpec.options.push({
    id: 'reject-with-auth',
    label: 'Reject but authorize',
    decision: { type: 'reject' },
    effects: [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    }],
  });

  assertResolutionError(
    () => resolveHumanReviewResponse(pending, {
      reviewId: 'review-1',
      selectedOptionId: 'reject-with-auth',
    }),
    'invalid_effect',
  );
});
