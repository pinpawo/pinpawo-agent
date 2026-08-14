import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import { buildCommandPaletteModel } from '../input/commandPalette';
import type { FileMentionModel } from '../input/fileMention';
import type { TuiOverlayModel } from '../overlayModel';
import type { ApprovalRequestModel } from '../state/tuiState';
import type { ResumeSessionSummary } from '../types';
import { ApprovalPanel } from './ApprovalPanel';
import { CommandPalette } from './CommandPalette';
import { FileMentionPopup } from './FileMentionPopup';
import { GlobalReviewPolicyPicker } from './GlobalReviewPolicyPicker';
import { OverlayLayer } from './OverlayLayer';
import { ResumePicker } from './ResumePicker';

const OPEN_FILE_MENTION: FileMentionModel = {
  open: true,
  query: 'doc',
  replacementStart: 4,
  replacementEnd: 8,
  selectedIndex: 0,
  items: [{ path: 'docs/design/tui/overhaul.md', type: 'file' }],
};

test('OverlayLayer renders nothing when no overlay owns the slot', () => {
  assert.equal(OverlayLayer({
    model: {
      current: null,
      width: 80,
    },
  }), null);
});

test('OverlayLayer renders exactly the current overlay component', () => {
  assertOverlayComponent(
    overlayModel({
      type: 'resumePicker',
      label: 'Resume',
      sessions: [resumeSession()],
      selectedIndex: 0,
      loading: false,
    }),
    ResumePicker,
  );
  assertOverlayComponent(
    overlayModel({
      type: 'approval',
      label: 'Approval',
      request: approvalRequest(),
      selectedIndex: 1,
    }),
    ApprovalPanel,
  );
  assertOverlayComponent(
    overlayModel({
      type: 'globalReviewPolicyPicker',
      label: 'Policy',
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    }),
    GlobalReviewPolicyPicker,
  );
  assertOverlayComponent(
    overlayModel({
      type: 'commandPalette',
      label: 'Command',
      model: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    }),
    CommandPalette,
  );
  assertOverlayComponent(
    overlayModel({
      type: 'fileMention',
      label: 'File',
      model: OPEN_FILE_MENTION,
    }),
    FileMentionPopup,
  );
});

function assertOverlayComponent(model: TuiOverlayModel, expectedType: unknown) {
  const element = OverlayLayer({ model });
  assert.ok(isValidElement(element));
  const inspected = element as { type: unknown; props: Record<string, unknown> };
  assert.equal(inspected.type, expectedType);
  assert.equal(inspected.props.width, model.width);
}

function overlayModel(current: NonNullable<TuiOverlayModel['current']>): TuiOverlayModel {
  return {
    current,
    width: 80,
  };
}

function resumeSession(): ResumeSessionSummary {
  return {
    id: 'sess-1',
    kind: 'chat',
    title: 'Chat',
    messageCount: 2,
    createdAt: '2026-06-23T00:00:00Z',
    updatedAt: '2026-06-23T00:01:00Z',
    active: true,
  };
}

function approvalRequest(): ApprovalRequestModel {
  const review = {
    interactionId: 'review-1',
    schemaVersion: 2 as const,
    view: { kind: 'plain' as const, body: 'Need review' },
    options: [],
  };
  return {
    requestId: 'req-1',
    actionId: 'interrupt-1',
    petId: 'pet-1',
    review,
    reviews: [review],
    decisions: [],
  };
}
