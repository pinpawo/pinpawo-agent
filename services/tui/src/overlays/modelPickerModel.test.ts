import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginModelPickerLoad,
  beginModelSelection,
  createModelPickerState,
  formatModelPicker,
  loadModelPickerProfiles,
  moveModelPickerSelection,
  resolveModelPickerKey,
  selectedModelProfile,
} from './modelPickerModel';

test('model picker exposes compatible and incompatible profiles without hiding either', () => {
  const loading = beginModelPickerLoad(createModelPickerState(), 'vision');
  const state = loadModelPickerProfiles({
    sessionId: 'session-1',
    defaultProfileId: 'text',
    selectedProfileId: 'vision',
    requiredInputModalities: ['text', 'image'],
    profiles: [{
      id: 'text',
      label: 'Text',
      inputModalities: ['text'],
      available: true,
      compatible: false,
      issues: ['Session requires image input.'],
    }, {
      id: 'vision',
      label: 'Vision',
      inputModalities: ['text', 'image'],
      available: true,
      compatible: true,
      issues: [],
    }],
  });

  assert.equal(loading.phase, 'loading');
  assert.equal(state.selectedIndex, 1);
  const disabled = moveModelPickerSelection(state, -1);
  assert.equal(selectedModelProfile(disabled)?.id, 'text');
  assert.equal(beginModelSelection(disabled).phase, 'error');
  assert.equal(beginModelSelection(state).phase, 'selecting');
  assert.match(formatModelPicker(state, 80), /incompatible/);
  assert.equal(resolveModelPickerKey(state, { name: 'return', ctrl: false }), 'select');
  assert.equal(
    resolveModelPickerKey(beginModelSelection(state), {
      name: 'escape',
      ctrl: false,
    }),
    null,
  );
});

test('model picker windows a large registry around the selected profile', () => {
  const state = loadModelPickerProfiles({
    sessionId: 'session-1',
    defaultProfileId: 'profile-0',
    selectedProfileId: 'profile-6',
    requiredInputModalities: ['text'],
    profiles: Array.from({ length: 8 }, (_, index) => ({
      id: `profile-${index}`,
      label: `Profile ${index}`,
      inputModalities: ['text' as const],
      available: true,
      compatible: true,
      issues: [],
    })),
  });

  const output = formatModelPicker(state, 80);
  assert.match(output, /7\/8/);
  assert.match(output, /Profile 6/);
  assert.doesNotMatch(output, /Profile 0/);
  assert.ok(output.split('\n').length <= 7);
});
