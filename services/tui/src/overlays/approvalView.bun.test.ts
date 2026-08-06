import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { AgentRunView, ReviewSpec } from '@pinpawo/agent-session';
import {
  advanceApprovalSubmissionFrame,
  beginApprovalSubmission,
  createApprovalState,
  moveApprovalSelection,
  setApprovalDraft,
  syncApprovalState,
} from './approvalModel';
import { ApprovalView } from './approvalView';

test('approval view remains bounded and accepts multiline input after resize', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 18,
  });
  context.after(() => setup.renderer.destroy());
  const root = new BoxRenderable(setup.renderer, {
    width: '100%',
    height: '100%',
    backgroundColor: RGBA.defaultBackground(),
  });
  let draft = '';
  const view = new ApprovalView(setup.renderer, {
    onDraftChange: (value) => {
      draft = value;
    },
  });
  root.add(view.frame);
  setup.renderer.root.add(root);

  let state = syncApprovalState(createApprovalState(), waitingReview());
  view.render(state, 60, setup.renderer.height);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Review 1\/1/);
  assert.match(initial, /是否允许执行/);
  assert.match(initial, /批准/);
  assert.match(initial, /^ {4}┌/m);
  assert.equal(frameRows(initial).length, 18);

  state = moveApprovalSelection(state, 1);
  view.render(state, 60, setup.renderer.height);
  view.focusInput();
  await setup.mockInput.pasteBracketedText('第一行\nsecond line');
  state = setApprovalDraft(state, draft);
  setup.resize(34, 18);
  view.render(state, 34, setup.renderer.height);
  await setup.flush();

  assert.equal(view.input.plainText, '第一行\nsecond line');
  const resized = setup.captureCharFrame();
  assert.match(resized, /回复/);
  assert.equal(frameRows(resized).length, 18);
  assert.ok(frameRows(resized).every((line) => line.length <= 34), resized);

  setup.resize(34, 9);
  view.render(state, 34, setup.renderer.height);
  await setup.flush();
  const compact = setup.captureCharFrame();
  assert.match(compact, /回复/);
  assert.match(compact, /第一行/);
  assert.equal(frameRows(compact).length, 9);

  state = beginApprovalSubmission(state);
  view.render(state, 34, setup.renderer.height);
  await setup.flush();
  const submitting = setup.captureCharFrame();
  assert.match(submitting, /Submitting review/);
  assert.doesNotMatch(submitting, /批准|回复|第一行/);
  assert.doesNotMatch(submitting, /[\u2800-\u28ff]/);

  state = advanceApprovalSubmissionFrame(state);
  view.render(state, 34, setup.renderer.height);
  await setup.flush();
  assert.equal(setup.captureCharFrame(), submitting);
});

function waitingReview(): AgentRunView {
  return {
    requestId: 'request-1',
    state: 'waiting_review',
    reviewAction: {
      actionId: 'action-1',
      reviews: [review()],
    },
  };
}

function review(): ReviewSpec {
  return {
    interactionId: 'review-1',
    schemaVersion: 2,
    view: {
      kind: 'plain',
      title: '需要确认',
      body: '是否允许执行这个操作？',
    },
    options: [{
      id: 'approve',
      label: '批准',
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
    }],
  };
}

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
