import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveHumanReviewResume,
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
} from './review/reviewResponseResolver';
import {
  appendReviewViewMessage,
  isHumanReviewInterruptPayload,
  isReviewSpecValue,
  reviewViewToText,
} from './review/reviewSpec';
import type { ReviewResolutionContext } from './review/reviewSpec';

function samplePendingReview(): ReviewResolutionContext {
  return {
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

test('review spec guards accept canonical values only', () => {
  const reviewSpec = samplePendingReview().reviewSpec;

  assert.equal(isReviewSpecValue(reviewSpec), true);
  assert.equal(isHumanReviewInterruptPayload({
    kind: 'review',
    review: reviewSpec,
    pendingAction: {
      actionId: 'action-1',
      toolName: 'run_shell',
      args: { command: 'git status' },
    },
  }), true);
  assert.equal(isHumanReviewInterruptPayload({ kind: 'review' }), false);
  assert.equal(isReviewSpecValue({
    ...reviewSpec,
    options: [{
      id: 'edit',
      label: 'Edit',
      decision: { type: 'edit' },
    }],
  }), false);
  assert.equal(isReviewSpecValue({
    ...reviewSpec,
    extra: true,
  }), false);
});

test('review spec guards accept a diff view and reject malformed ones', () => {
  const reviewSpec = samplePendingReview().reviewSpec;
  const diffView = {
    kind: 'diff' as const,
    title: '应用补丁',
    summary: 'update',
    target: 'src/example.ts',
    patch: '*** Begin Patch\n*** End Patch',
  };

  assert.equal(isReviewSpecValue({ ...reviewSpec, view: diffView }), true);
  // diff view without the required patch string is rejected.
  assert.equal(isReviewSpecValue({
    ...reviewSpec,
    view: { kind: 'diff', title: 'x' },
  }), false);
  // unknown keys are rejected like the other view variants.
  assert.equal(isReviewSpecValue({
    ...reviewSpec,
    view: { ...diffView, body: 'should not be here' },
  }), false);
});

test('reviewViewToText flattens a diff view and appendReviewViewMessage degrades to plain', () => {
  const diffView = {
    kind: 'diff' as const,
    title: '应用补丁',
    summary: 'update',
    target: 'src/example.ts',
    patch: '*** Begin Patch\n*** End Patch',
  };

  const text = reviewViewToText(diffView);
  assert.match(text, /Summary: update/);
  assert.match(text, /Target: src\/example\.ts/);
  assert.match(text, /\*\*\* Begin Patch/);

  const appended = appendReviewViewMessage(diffView, '请确认');
  assert.equal(appended.kind, 'plain');
  assert.match((appended as { body: string }).body, /\*\*\* Begin Patch/);
  assert.match((appended as { body: string }).body, /请确认$/);
  assert.equal(appended.title, '应用补丁');
});

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

test('resolveHumanReviewResume resolves canonical responses only', () => {
  assert.deepEqual(
    resolveHumanReviewResume(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'approve-with-auth',
    }).effects,
    [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    }],
  );
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

test('resolveHumanReviewResume rejects legacy decisions and extra response fields', () => {
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      decisions: [{ type: 'approve' }],
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      reviewId: 'old-review',
      selectedOptionId: 'approve',
      decisions: [{ type: 'approve' }],
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      selectedOptionId: 'approve',
      decisions: [{ type: 'approve' }],
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      decision: { type: 'approve' },
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'approve',
      effects: [],
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      type: 'human_review_response',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    }),
    'invalid_response',
  );
  assertResolutionError(
    () => resolveHumanReviewResume(samplePendingReview(), {
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: 'please continue',
    }),
    'invalid_response',
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
