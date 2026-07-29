import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import { buildCommandPaletteModel } from './input/commandPalette';
import type { FileMentionModel } from './input/fileMention';
import { buildTuiOverlayModel } from './overlayModel';
import type { ApprovalRequestModel } from './state/tuiState';

const CLOSED_FILE_MENTION: FileMentionModel = {
  open: false,
  query: '',
  replacementStart: 0,
  replacementEnd: 0,
  selectedIndex: 0,
  items: [],
};

const OPEN_FILE_MENTION: FileMentionModel = {
  open: true,
  query: 'doc',
  replacementStart: 4,
  replacementEnd: 8,
  selectedIndex: 0,
  items: [{ path: 'docs/TUI_OVERHAUL_DESIGN.md', type: 'file' }],
};

test('buildTuiOverlayModel renders the selected interaction owner', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'resumePicker' },
    resumePicker: {
      open: true,
      sessions: [{
        id: 'sess-1',
        kind: 'chat',
        title: 'Chat',
        messageCount: 2,
        createdAt: '2026-06-23T00:00:00Z',
        updatedAt: '2026-06-23T00:01:00Z',
        active: true,
      }],
      selectedIndex: 0,
      loading: false,
    },
    approval: {
      request: approvalRequest(),
      selectedIndex: 1,
    },
    globalReviewPolicyPicker: {
      open: true,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current?.type, 'resumePicker');
  assert.equal(model.current?.label, 'Resume');
});

test('buildTuiOverlayModel renders command palette when it owns interaction', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'commandPalette' },
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: null, selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: false,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current?.type, 'commandPalette');
  assert.equal(model.current?.label, 'Command');
});

test('buildTuiOverlayModel renders approval when it owns interaction', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'approval', freeTextActive: false },
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: approvalRequest(), selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: true,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current?.type, 'approval');
  assert.equal(model.current?.label, 'Approval');
});

test('buildTuiOverlayModel renders policy picker when it owns interaction', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'globalReviewPolicyPicker' },
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: null, selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: true,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current?.type, 'globalReviewPolicyPicker');
  assert.equal(model.current?.label, 'Policy');
});

test('buildTuiOverlayModel renders model profile picker when it owns interaction', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'modelProfilePicker' },
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: null, selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: false,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    modelProfilePicker: {
      open: true,
      profiles: [{
        id: 'vision',
        label: 'Vision',
        inputModalities: ['text', 'image'],
        available: true,
        compatible: true,
        issues: [],
      }],
      selectedProfileId: 'vision',
      defaultProfileId: 'vision',
      requiredInputModalities: ['text', 'image'],
      selectedIndex: 0,
      loading: false,
      applying: false,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current?.type, 'modelProfilePicker');
  assert.equal(model.current?.label, 'Model');
});

test('buildTuiOverlayModel returns no owner when all overlays are closed', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'composer' },
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: null, selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: false,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '', cursorOffset: 0 }),
    fileMention: CLOSED_FILE_MENTION,
  });

  assert.equal(model.current, null);
});

test('buildTuiOverlayModel does not infer an overlay from open state', () => {
  const model = buildTuiOverlayModel({
    width: 80,
    owner: { type: 'externalEditor' },
    resumePicker: { open: true, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: approvalRequest(), selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: true,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
    fileMention: OPEN_FILE_MENTION,
  });

  assert.equal(model.current, null);
});

function approvalRequest(): ApprovalRequestModel {
  const review = {
    id: 'review-1',
    schemaVersion: 1,
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
