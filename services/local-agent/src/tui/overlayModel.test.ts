import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import { buildCommandPaletteModel } from './input/commandPalette';
import type { FileMentionModel } from './input/fileMention';
import { resolveTuiInputOwner } from './input/inputRouter';
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

test('buildTuiOverlayModel selects the highest-priority active overlay', () => {
  const model = buildTuiOverlayModel({
    width: 80,
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
  assert.equal(model.owner, 'resumePicker');
  assert.equal(model.ownerLabel, 'Resume');
});

test('buildTuiOverlayModel keeps command palette above file mention', () => {
  const model = buildTuiOverlayModel({
    width: 80,
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
  assert.equal(model.owner, 'commandPalette');
  assert.equal(model.ownerLabel, 'Command');
});

test('buildTuiOverlayModel keeps approval above policy and inline popups', () => {
  const model = buildTuiOverlayModel({
    width: 80,
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
  assert.equal(model.owner, 'approval');
  assert.equal(model.ownerLabel, 'Approval');
});

test('buildTuiOverlayModel keeps policy picker above inline popups', () => {
  const model = buildTuiOverlayModel({
    width: 80,
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
  assert.equal(model.owner, 'globalReviewPolicyPicker');
  assert.equal(model.ownerLabel, 'Policy');
});

test('buildTuiOverlayModel visible owner priority stays aligned with input owner routing', () => {
  const cases = [
    {
      name: 'resume',
      expectedOwner: 'resumePicker',
      overlay: overlayInput({
        resumePicker: { open: true, sessions: [], selectedIndex: 0, loading: false },
        approval: { request: approvalRequest(), selectedIndex: 0 },
        globalReviewPolicyPicker: {
          open: true,
          currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
          selectedIndex: 0,
        },
        commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
        fileMention: OPEN_FILE_MENTION,
      }),
      input: {
        ready: true,
        busy: false,
        hasPendingApproval: true,
        hasResumePicker: true,
        hasGlobalReviewPolicyPicker: true,
        hasCommandPalette: true,
        hasFileMention: true,
      },
    },
    {
      name: 'approval',
      expectedOwner: 'approval',
      overlay: overlayInput({
        approval: { request: approvalRequest(), selectedIndex: 0 },
        globalReviewPolicyPicker: {
          open: true,
          currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
          selectedIndex: 0,
        },
        commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
        fileMention: OPEN_FILE_MENTION,
      }),
      input: {
        ready: true,
        busy: false,
        hasPendingApproval: true,
        hasResumePicker: false,
        hasGlobalReviewPolicyPicker: true,
        hasCommandPalette: true,
        hasFileMention: true,
      },
    },
    {
      name: 'policy',
      expectedOwner: 'globalReviewPolicyPicker',
      overlay: overlayInput({
        globalReviewPolicyPicker: {
          open: true,
          currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
          selectedIndex: 0,
        },
        commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
        fileMention: OPEN_FILE_MENTION,
      }),
      input: {
        ready: true,
        busy: false,
        hasPendingApproval: false,
        hasResumePicker: false,
        hasGlobalReviewPolicyPicker: true,
        hasCommandPalette: true,
        hasFileMention: true,
      },
    },
    {
      name: 'command',
      expectedOwner: 'commandPalette',
      overlay: overlayInput({
        commandPalette: buildCommandPaletteModel({ text: '/', cursorOffset: 1 }),
        fileMention: OPEN_FILE_MENTION,
      }),
      input: {
        ready: true,
        busy: false,
        hasPendingApproval: false,
        hasResumePicker: false,
        hasCommandPalette: true,
        hasFileMention: true,
      },
    },
    {
      name: 'file',
      expectedOwner: 'fileMention',
      overlay: overlayInput({
        fileMention: OPEN_FILE_MENTION,
      }),
      input: {
        ready: true,
        busy: false,
        hasPendingApproval: false,
        hasResumePicker: false,
        hasFileMention: true,
      },
    },
  ] as const;

  for (const { name, expectedOwner, overlay, input } of cases) {
    assert.equal(buildTuiOverlayModel(overlay).owner, expectedOwner, name);
    assert.equal(resolveTuiInputOwner(input).type, expectedOwner, name);
  }
});

test('buildTuiOverlayModel returns no owner when all overlays are closed', () => {
  const model = buildTuiOverlayModel({
    width: 80,
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
  assert.equal(model.owner, null);
  assert.equal(model.ownerLabel, null);
});

function overlayInput(
  overrides: Partial<Parameters<typeof buildTuiOverlayModel>[0]> = {},
): Parameters<typeof buildTuiOverlayModel>[0] {
  return {
    width: 80,
    resumePicker: { open: false, sessions: [], selectedIndex: 0, loading: false },
    approval: { request: null, selectedIndex: 0 },
    globalReviewPolicyPicker: {
      open: false,
      currentMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      selectedIndex: 0,
    },
    commandPalette: buildCommandPaletteModel({ text: '', cursorOffset: 0 }),
    fileMention: CLOSED_FILE_MENTION,
    ...overrides,
  };
}

function approvalRequest(): ApprovalRequestModel {
  return {
    requestId: 'req-1',
    petId: 'pet-1',
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Need review' },
      options: [],
    },
  };
}
