import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCurrentInputFromController } from './commandSubmit';
import type { TuiAction } from '../state/tuiState';

function createSubmitHarness(overrides: {
  inputValue?: string;
  openExternalEditor?: (initialText: string) => void;
  serverMode?: 'chat' | 'studio';
  studioConversationIdRef?: { current: string | null };
} = {}) {
  const messages: string[] = [];
  const actions: TuiAction[] = [];
  const sent: string[] = [];
  const studioConversationIdRef = overrides.studioConversationIdRef ?? { current: null };
  return {
    messages,
    actions,
    sent,
    studioConversationIdRef,
    submit: () => submitCurrentInputFromController({
      inputValue: overrides.inputValue ?? '',
      focusedSession: null,
      serverMode: overrides.serverMode ?? 'chat',
      studioConversationIdRef,
      openResumePicker: () => {},
      openExternalEditor: overrides.openExternalEditor,
      exit: () => {},
      appendSystemMessage: (text) => messages.push(text),
      clearInputValue: () => sent.push('clear'),
      dispatch: (action) => actions.push(action),
      runtimeController: {
        isConnected: () => true,
        isBusy: () => false,
        sendStudioRequest: (_request, conversationId) => {
          sent.push(`studio:${conversationId ?? ''}`);
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

test('submitCurrentInputFromController sends text as studio request in studio server mode', () => {
  const conversation = { current: 'conv-1' };
  const harness = createSubmitHarness({
    inputValue: 'plan this',
    serverMode: 'studio',
    studioConversationIdRef: conversation,
  });

  harness.submit();

  assert.deepEqual(harness.sent, ['studio:conv-1']);
});

test('submitCurrentInputFromController resets studio conversation on /new in studio server mode', () => {
  const conversation = { current: 'conv-old' };
  const harness = createSubmitHarness({
    inputValue: '/new',
    serverMode: 'studio',
    studioConversationIdRef: conversation,
  });

  harness.submit();

  assert.deepEqual(harness.sent, ['new']);
  assert.notEqual(harness.studioConversationIdRef.current, 'conv-old');
  assert.equal(harness.actions.some((action) => action.type === 'session.set_kind' && action.kind === 'studio'), true);
});

test('submitCurrentInputFromController reports missing external editor hook', () => {
  const harness = createSubmitHarness({ inputValue: '/edit' });

  harness.submit();

  assert.deepEqual(harness.sent, ['clear']);
  assert.equal(harness.messages.length, 1);
});
