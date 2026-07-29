import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTuiInteractionOwner,
  type TuiInteractionState,
} from './interactionOwner';

const IDLE: TuiInteractionState = {
  ready: true,
  busy: false,
  pendingApproval: false,
  resumePickerOpen: false,
};

test('resolveTuiInteractionOwner applies one priority across all interaction owners', () => {
  const cases: Array<{
    state: TuiInteractionState;
    expected: ReturnType<typeof resolveTuiInteractionOwner>;
  }> = [
    {
      state: {
        ...IDLE,
        ready: false,
        externalEditorOpen: true,
        transcriptViewerOpen: true,
        resumePickerOpen: true,
      },
      expected: { type: 'externalEditor' },
    },
    {
      state: {
        ...IDLE,
        ready: false,
        busy: true,
        transcriptViewerOpen: true,
      },
      expected: { type: 'transcriptViewer' },
    },
    {
      state: { ...IDLE, ready: false, busy: true, resumePickerOpen: true },
      expected: { type: 'unready' },
    },
    {
      state: { ...IDLE, busy: true, pendingApproval: true, resumePickerOpen: true },
      expected: { type: 'resumePicker' },
    },
    {
      state: {
        ...IDLE,
        busy: true,
        pendingApproval: true,
        globalReviewPolicyPickerOpen: true,
      },
      expected: { type: 'approval', freeTextActive: false },
    },
    {
      state: {
        ...IDLE,
        busy: true,
        pendingApproval: true,
        approvalFreeTextActive: true,
      },
      expected: { type: 'approval', freeTextActive: true },
    },
    {
      state: { ...IDLE, busy: true, globalReviewPolicyPickerOpen: true },
      expected: { type: 'globalReviewPolicyPicker' },
    },
    {
      state: { ...IDLE, busy: true, modelProfilePickerOpen: true },
      expected: { type: 'modelProfilePicker' },
    },
    {
      state: { ...IDLE, busy: true, commandPaletteOpen: true },
      expected: { type: 'busy' },
    },
    {
      state: { ...IDLE, commandPaletteOpen: true, fileMentionOpen: true },
      expected: { type: 'commandPalette' },
    },
    {
      state: { ...IDLE, fileMentionOpen: true },
      expected: { type: 'fileMention' },
    },
    {
      state: IDLE,
      expected: { type: 'composer' },
    },
  ];

  for (const { state, expected } of cases) {
    assert.deepEqual(resolveTuiInteractionOwner(state), expected);
  }
});
