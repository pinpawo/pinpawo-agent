import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type {
  AgentRunView,
  ReviewResponse,
  ReviewSpec,
} from '@pinpawo/agent-session';
import {
  advanceApproval,
  advanceApprovalSubmissionFrame,
  approvalAcceptsTextInput,
  beginApprovalSubmission,
  buildApprovalViewModel,
  calculateApprovalDialogLayout,
  createApprovalState,
  currentApprovalReview,
  moveApprovalSelection,
  resolveApprovalKey,
  scrollApprovalContent,
  selectedApprovalOption,
  setApprovalDraft,
  syncApprovalState,
  updateApprovalResolutionSent,
} from './approvalModel';

test('approval state follows the canonical waiting review and defaults to primary', () => {
  const run = waitingReview([review('review-1')]);
  const state = syncApprovalState(createApprovalState(), run);
  assert.equal(state.phase, 'ready');
  assert.equal(selectedApprovalOption(state)?.id, 'approve');
  assert.equal(
    syncApprovalState(state, { ...run, state: 'running', activity: 'thinking' }).phase,
    'closed',
  );
});

test('approval navigation yields to free-text editing after the draft starts', () => {
  let state = syncApprovalState(createApprovalState(), waitingReview([review('review-1')]));
  state = moveApprovalSelection(state, 1);
  assert.equal(selectedApprovalOption(state)?.id, 'respond');
  assert.equal(approvalAcceptsTextInput(state), true);
  assert.equal(resolveApprovalKey(state, key('up')), 'previous-option');

  state = setApprovalDraft(state, '需要补充说明');
  assert.equal(resolveApprovalKey(state, key('up')), null);
  assert.equal(resolveApprovalKey(state, key('return', false, true)), null);
  assert.equal(resolveApprovalKey(state, key('return')), 'submit');
  assert.equal(resolveApprovalKey(state, key('escape')), 'cancel');
});

test('approved batch decisions advance locally before transport submission', () => {
  let state = syncApprovalState(createApprovalState(), waitingReview([
    review('review-1'),
    review('review-2'),
  ]));
  const decisions: ReviewResponse[] = [{
    interactionId: 'review-1',
    selectedOptionId: 'approve',
  }];
  state = advanceApproval(state, decisions);
  assert.equal(currentApprovalReview(state)?.interactionId, 'review-2');
  assert.deepEqual(state.phase === 'closed' ? null : state.decisions, decisions);
  assert.equal(state.phase === 'closed' ? null : state.draft, '');

  state = beginApprovalSubmission(state);
  assert.equal(state.phase, 'resolution-sent');
  assert.equal(resolveApprovalKey(state, key('escape')), null);
  const submitting = buildApprovalViewModel(state, 80, 13);
  state = advanceApprovalSubmissionFrame(state);
  if (state.phase === 'closed') assert.fail('submission unexpectedly closed');
  const nextSubmittingFrame = buildApprovalViewModel(
    state,
    80,
    13,
  );
  assert.equal(submitting.options, '');
  assert.equal(submitting.optionRows, 0);
  assert.equal(submitting.inputVisible, false);
  assert.match(submitting.body, /Submitting review decision/);
  assert.equal(submitting.loadingFrame, 0);
  assert.equal(nextSubmittingFrame.loadingFrame, 1);
  assert.equal(nextSubmittingFrame.body, submitting.body);
  state = updateApprovalResolutionSent(state, {
    interruptSent: true,
    message: 'Interrupt requested',
  });
  assert.equal(state.phase === 'closed' ? false : state.interruptSent, true);
  assert.match(
    state.phase === 'closed'
      ? ''
      : buildApprovalViewModel(state, 80).bottomTitle,
    /Interrupt requested/,
  );
});

test('approval diff details page within a bounded CJK footer view', () => {
  const diffReview: ReviewSpec = {
    interactionId: 'review-diff',
    schemaVersion: 2,
    view: {
      kind: 'diff',
      title: '修改配置',
      summary: '请检查以下变更',
      target: '/tmp/配置.ts',
      patch: Array.from(
        { length: 12 },
        (_, index) => `+ 第 ${index + 1} 行：宽字符内容`,
      ).join('\n'),
    },
    options: [{
      id: 'approve',
      label: '批准',
      continuesReviewBatch: true,
    }, {
      id: 'reject',
      label: '拒绝',
      variant: 'danger',
      continuesReviewBatch: false,
    }],
  };
  let state = syncApprovalState(createApprovalState(), waitingReview([diffReview]));
  const first = state.phase === 'closed'
    ? null
    : buildApprovalViewModel(state, 32);
  assert.ok(first);
  assert.match(first?.title ?? '', /1-11\//);

  state = scrollApprovalContent(state, 1, 32);
  const second = state.phase === 'closed'
    ? null
    : buildApprovalViewModel(state, 32);
  assert.notEqual(second?.body, first?.body);
  for (const line of `${second?.body}\n${second?.options}`.split('\n')) {
    assert.ok(stringWidth(line) <= 28, line);
  }
});

test('approval shares fixed footer rows dynamically between content and options', () => {
  const base = review('review-dynamic');
  const options: ReviewSpec['options'] = [
    base.options[0]!,
    {
      id: 'authorize',
      label: '批准并授权',
      continuesReviewBatch: true,
    },
    ...base.options.slice(1),
  ];
  const shortReview: ReviewSpec = {
    ...base,
    view: {
      kind: 'plain',
      title: '写文件',
      body: 'Target: /tmp/example.txt',
    },
    options,
  };
  const shortState = syncApprovalState(
    createApprovalState(),
    waitingReview([shortReview]),
  );
  const short = shortState.phase === 'closed'
    ? null
    : buildApprovalViewModel(shortState, 80);
  assert.equal(short?.bodyRows, 2);
  assert.equal(short?.optionRows, 4);
  assert.match(short?.body ?? '', /example\.txt/);
  assert.match(short?.options ?? '', /拒绝/);

  const longReview: ReviewSpec = {
    ...shortReview,
    view: {
      kind: 'plain',
      title: '写文件',
      body: Array.from(
        { length: 8 },
        (_, index) => `Detail ${index + 1}`,
      ).join('\n'),
    },
  };
  const longState = syncApprovalState(
    createApprovalState(),
    waitingReview([longReview]),
  );
  const long = longState.phase === 'closed'
    ? null
    : buildApprovalViewModel(longState, 80);
  assert.equal(long?.bodyRows, 9);
  assert.equal(long?.optionRows, 4);
  assert.doesNotMatch(long?.title ?? '', /details/);

  const compact = longState.phase === 'closed'
    ? null
    : buildApprovalViewModel(longState, 80, 9);
  assert.equal(compact?.bodyRows, 4);
  assert.equal(compact?.optionRows, 2);
  assert.match(compact?.title ?? '', /details 1-4\/9/);

  const compactNextState = scrollApprovalContent(longState, 1, 80, 9);
  const compactNext = compactNextState.phase === 'closed'
    ? null
    : buildApprovalViewModel(compactNextState, 80, 9);
  assert.match(compactNext?.title ?? '', /details 5-8\/9/);
});

test('approval dialog is centered within its temporary footer surface', () => {
  assert.deepEqual(calculateApprovalDialogLayout(128, 18), {
    width: 112,
    height: 16,
    left: 8,
    top: 1,
  });
  assert.deepEqual(calculateApprovalDialogLayout(34, 9), {
    width: 32,
    height: 7,
    left: 1,
    top: 1,
  });
});

function waitingReview(reviews: ReviewSpec[]): AgentRunView {
  return {
    requestId: 'request-1',
    state: 'waiting_review',
    reviewAction: {
      actionId: 'action-1',
      reviews,
      petId: 'paws',
    },
  };
}

function review(id: string): ReviewSpec {
  return {
    interactionId: id,
    schemaVersion: 2,
    view: {
      kind: 'plain',
      title: '需要确认',
      body: '是否允许执行这个操作？',
    },
    options: [{
      id: 'approve',
      label: '批准',
      variant: 'primary',
      continuesReviewBatch: true,
    }, {
      id: 'respond',
      label: '回复',
      input: {
        kind: 'text',
        key: 'message',
        multiline: true,
      },
      continuesReviewBatch: false,
    }, {
      id: 'reject',
      label: '拒绝',
      variant: 'danger',
      continuesReviewBatch: false,
    }],
  };
}

function key(name: string, ctrl = false, shift = false) {
  return { name, ctrl, shift };
}
