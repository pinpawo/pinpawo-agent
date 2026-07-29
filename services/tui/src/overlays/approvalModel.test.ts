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
  approvalAcceptsTextInput,
  beginApprovalSubmission,
  buildApprovalViewModel,
  createApprovalState,
  currentApprovalReview,
  moveApprovalSelection,
  resolveApprovalKey,
  scrollApprovalContent,
  selectedApprovalOption,
  setApprovalDraft,
  syncApprovalState,
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
    reviewId: 'review-1',
    selectedOptionId: 'approve',
  }];
  state = advanceApproval(state, decisions);
  assert.equal(currentApprovalReview(state)?.id, 'review-2');
  assert.deepEqual(state.phase === 'closed' ? null : state.decisions, decisions);
  assert.equal(state.phase === 'closed' ? null : state.draft, '');

  state = beginApprovalSubmission(state);
  assert.equal(state.phase, 'submitting');
  assert.equal(resolveApprovalKey(state, key('escape')), null);
});

test('approval diff details page within a bounded CJK footer view', () => {
  const diffReview: ReviewSpec = {
    id: 'review-diff',
    schemaVersion: 1,
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
      decision: { type: 'approve' },
    }, {
      id: 'reject',
      label: '拒绝',
      variant: 'danger',
      decision: { type: 'reject' },
    }],
  };
  let state = syncApprovalState(createApprovalState(), waitingReview([diffReview]));
  const first = state.phase === 'closed'
    ? null
    : buildApprovalViewModel(state, 32);
  assert.ok(first);
  assert.match(first?.title ?? '', /1-3\//);

  state = scrollApprovalContent(state, 1, 32);
  const second = state.phase === 'closed'
    ? null
    : buildApprovalViewModel(state, 32);
  assert.notEqual(second?.body, first?.body);
  for (const line of `${second?.body}\n${second?.options}`.split('\n')) {
    assert.ok(stringWidth(line) <= 28, line);
  }
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
    id,
    schemaVersion: 1,
    view: {
      kind: 'plain',
      title: '需要确认',
      body: '是否允许执行这个操作？',
    },
    options: [{
      id: 'approve',
      label: '批准',
      variant: 'primary',
      decision: { type: 'approve' },
    }, {
      id: 'respond',
      label: '回复',
      input: {
        kind: 'text',
        key: 'message',
        multiline: true,
      },
      decision: {
        type: 'respond',
        messageInputKey: 'message',
      },
    }, {
      id: 'reject',
      label: '拒绝',
      variant: 'danger',
      decision: { type: 'reject' },
    }],
  };
}

function key(name: string, ctrl = false, shift = false) {
  return { name, ctrl, shift };
}
