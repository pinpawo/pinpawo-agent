import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSelectModelProfile,
  createLoadedModelProfilePicker,
  moveModelProfilePickerSelection,
  readModelProfileSelectionIssue,
} from './modelProfilePicker';

const profiles = [
  {
    id: 'text',
    label: 'Text',
    inputModalities: ['text' as const],
    available: true,
    compatible: false,
    issues: ['Session requires image input.'],
  },
  {
    id: 'vision',
    label: 'Vision',
    inputModalities: ['text' as const, 'image' as const],
    available: true,
    compatible: true,
    issues: [],
  },
];

test('model profile picker focuses the current profile and preserves disabled entries', () => {
  const state = createLoadedModelProfilePicker({
    sessionId: 'session-1',
    defaultProfileId: 'text',
    selectedProfileId: 'vision',
    requiredInputModalities: ['text', 'image'],
    profiles,
  });

  assert.equal(state.selectedIndex, 1);
  assert.equal(moveModelProfilePickerSelection(state, -1), 0);
  assert.equal(canSelectModelProfile(state.profiles[0]!), false);
  assert.equal(
    readModelProfileSelectionIssue(state.profiles[0]!),
    'Session requires image input.',
  );
  assert.equal(canSelectModelProfile(state.profiles[1]!), true);
});
