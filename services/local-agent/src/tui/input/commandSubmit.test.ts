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
    modelOpened: () => sent.includes('model'),
    transcriptOpened: () => sent.includes('transcript'),
    submit: () => submitCurrentInputFromController({
      inputValue: overrides.inputValue ?? '',
      focusedSession: null,
      openResumePicker: () => sent.push('resume'),
      openModelProfilePicker: () => sent.push('model'),
      openGlobalReviewPolicyPicker: () => sent.push('policy'),
      openTranscriptViewer: () => sent.push('transcript'),
      openExternalEditor: overrides.openExternalEditor,
      exit: () => {},
      appendSystemMessage: (text) => messages.push(text),
      clearInputValue: () => sent.push('clear'),
      dispatch: (action) => actions.push(action),
      runtimeController: {
        isConnected: () => true,
        isBusy: () => false,
        continueActiveDelegation: (message) => {
          sent.push(`continue:${message}`);
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

test('submitCurrentInputFromController sends explicit delegation continuation', () => {
  const harness = createSubmitHarness({
    inputValue: '/continue apply the new constraints',
  });

  harness.submit();

  assert.deepEqual(harness.actions.map((action) => action.type), ['session.configured']);
  assert.deepEqual(harness.sent, ['continue:apply the new constraints']);
});

test('submitCurrentInputFromController rejects empty continuation guidance', () => {
  const empty = createSubmitHarness({
    inputValue: '/continue',
  });

  empty.submit();

  assert.deepEqual(empty.sent, ['clear']);
  assert.deepEqual(empty.messages, [
    '请提供继续当前委派的指导：/continue <指导>',
  ]);
});

test('submitCurrentInputFromController opens the session model picker', () => {
  const harness = createSubmitHarness({
    inputValue: '/model',
  });

  harness.submit();

  assert.equal(harness.modelOpened(), true);
  assert.deepEqual(
    harness.actions.map((action) => action.type),
    ['session.configured'],
  );
  assert.deepEqual(harness.sent, ['model', 'clear']);
});

test('submitCurrentInputFromController opens global review policy picker for /policy', () => {
  const harness = createSubmitHarness({ inputValue: '/policy' });

  harness.submit();

  assert.equal(harness.policyOpened(), true);
  assert.deepEqual(harness.sent, ['policy', 'clear']);
});

test('submitCurrentInputFromController opens transcript viewer for /transcript', () => {
  const harness = createSubmitHarness({ inputValue: '/transcript' });

  harness.submit();

  assert.equal(harness.transcriptOpened(), true);
  assert.deepEqual(harness.sent, ['clear', 'transcript']);
});

test('submitCurrentInputFromController reports missing external editor hook', () => {
  const harness = createSubmitHarness({ inputValue: '/edit' });

  harness.submit();

  assert.deepEqual(harness.sent, ['clear']);
  assert.equal(harness.messages.length, 1);
});
