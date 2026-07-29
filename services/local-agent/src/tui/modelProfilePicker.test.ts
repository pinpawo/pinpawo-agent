import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSelectModelProfile,
  createLoadedModelProfilePicker,
  moveModelProfilePickerSelection,
  readModelProfileSelectionIssue,
  windowModelProfilePickerProfiles,
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

test('model profile picker windows a large registry around the selection', () => {
  const largeRegistry = Array.from({ length: 8 }, (_, index) => ({
    id: `profile-${index}`,
    label: `Profile ${index}`,
    inputModalities: ['text' as const],
    available: true,
    compatible: true,
    issues: [],
  }));

  const middle = windowModelProfilePickerProfiles(largeRegistry, 6);
  assert.equal(middle.start, 4);
  assert.deepEqual(
    middle.profiles.map((profile) => profile.id),
    ['profile-4', 'profile-5', 'profile-6', 'profile-7'],
  );

  const beginning = windowModelProfilePickerProfiles(largeRegistry, 0);
  assert.equal(beginning.start, 0);
  assert.equal(beginning.profiles.length, 4);
});
