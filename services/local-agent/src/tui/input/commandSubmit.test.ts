import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCurrentInputFromController } from './commandSubmit';
import type { TuiAction } from '../state/tuiState';

function createSubmitHarness(overrides: {
  inputValue?: string;
  openExternalEditor?: (initialText: string) => void;
} = {}) {
  const messages: string[] = [];
  const actions: TuiAction[] = [];
  const sent: string[] = [];
  return {
    messages,
    actions,
    sent,
    policyOpened: () => sent.includes('policy'),
    submit: () => submitCurrentInputFromController({
      inputValue: overrides.inputValue ?? '',
      focusedSession: null,
      studioModeRef: { current: false },
      studioConversationIdRef: { current: null },
      setStudioMode: () => {},
      openResumePicker: () => {},
      openGlobalReviewPolicyPicker: () => sent.push('policy'),
      openExternalEditor: overrides.openExternalEditor,
      exit: () => {},
      appendSystemMessage: (text) => messages.push(text),
      clearInputValue: () => sent.push('clear'),
      dispatch: (action) => actions.push(action),
      runtimeController: {
        isConnected: () => true,
        isBusy: () => false,
        sendStudioRequest: () => {
          sent.push('studio');
          return true;
        },
        sendChatRequest: () => {
          sent.push('chat');
          return true;
        },
        startNewSession: () => {
          sent.push('new');
        },
        submitReviewResponse: () => {
          sent.push('review');
          return true;
        },
      },
    }),
  };
}

test('submitCurrentInputFromController opens external editor for /edit', () => {
  let initialText: string | null = null;
  const harness = createSubmitHarness({
    inputValue: '/edit hello world',
    openExternalEditor: (value) => {
      initialText = value;
    },
  });

  harness.submit();

  assert.equal(initialText, 'hello world');
  assert.deepEqual(harness.sent, ['clear']);
  assert.deepEqual(harness.messages, []);
});

test('submitCurrentInputFromController opens global review policy picker for /policy', () => {
  const harness = createSubmitHarness({ inputValue: '/policy' });

  harness.submit();

  assert.equal(harness.policyOpened(), true);
  assert.deepEqual(harness.sent, ['policy', 'clear']);
});

test('submitCurrentInputFromController reports missing external editor hook', () => {
  const harness = createSubmitHarness({ inputValue: '/edit' });

  harness.submit();

  assert.deepEqual(harness.sent, ['clear']);
  assert.equal(harness.messages.length, 1);
});
