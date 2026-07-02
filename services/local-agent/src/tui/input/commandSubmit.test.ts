import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCurrentInputFromController } from './commandSubmit';
import type { TuiAction } from '../state/tuiState';

function createSubmitHarness(overrides: {
  inputValue?: string;
  openExternalEditor?: (initialText: string) => void;
  mode?: 'chat' | 'studio';
  studioConversationId?: string | null;
} = {}) {
  const messages: string[] = [];
  const actions: TuiAction[] = [];
  const sent: string[] = [];
  let mode = overrides.mode ?? 'chat';
  let studioConversationId = overrides.studioConversationId ?? null;
  return {
    messages,
    actions,
    sent,
    get mode() {
      return mode;
    },
    get studioConversationId() {
      return studioConversationId;
    },
    policyOpened: () => sent.includes('policy'),
    submit: () => submitCurrentInputFromController({
      inputValue: overrides.inputValue ?? '',
      focusedSession: null,
      mode,
      studioConversationId,
      enterStudioMode: (conversationId) => {
        mode = 'studio';
        studioConversationId = conversationId;
      },
      exitStudioMode: () => {
        mode = 'chat';
        studioConversationId = null;
      },
      openResumePicker: () => sent.push('resume'),
      openWorkspacePicker: () => sent.push('workspace'),
      openGlobalReviewPolicyPicker: () => sent.push('policy'),
      openExternalEditor: overrides.openExternalEditor,
      exit: () => {},
      appendSystemMessage: (text) => messages.push(text),
      clearInputValue: () => sent.push('clear'),
      dispatch: (action) => actions.push(action),
      runtimeController: {
        isConnected: () => true,
        isBusy: () => false,
        sendStudioRequest: (_text, conversationId) => {
          sent.push(`studio:${conversationId ?? 'none'}`);
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

test('submitCurrentInputFromController enters studio mode with one conversation id', () => {
  const harness = createSubmitHarness({ inputValue: '/studio plan' });

  harness.submit();

  assert.equal(harness.mode, 'studio');
  assert.equal(typeof harness.studioConversationId, 'string');
  assert.deepEqual(harness.actions.map((action) => action.type), ['session.set_kind']);
  assert.deepEqual(harness.sent, [`studio:${harness.studioConversationId}`]);
});

test('submitCurrentInputFromController exits studio mode for /chat', () => {
  const harness = createSubmitHarness({
    inputValue: '/chat',
    mode: 'studio',
    studioConversationId: 'conversation-1',
  });

  harness.submit();

  assert.equal(harness.mode, 'chat');
  assert.equal(harness.studioConversationId, null);
  assert.deepEqual(harness.actions.map((action) => action.type), ['session.set_kind']);
  assert.deepEqual(harness.sent, ['clear']);
});

test('submitCurrentInputFromController clears studio mode before /resume and /new', () => {
  const resumeHarness = createSubmitHarness({
    inputValue: '/resume',
    mode: 'studio',
    studioConversationId: 'conversation-1',
  });
  resumeHarness.submit();

  assert.equal(resumeHarness.mode, 'chat');
  assert.equal(resumeHarness.studioConversationId, null);
  assert.deepEqual(resumeHarness.actions.map((action) => action.type), ['session.set_kind']);
  assert.deepEqual(resumeHarness.sent, ['resume', 'clear']);

  const newHarness = createSubmitHarness({
    inputValue: '/new',
    mode: 'studio',
    studioConversationId: 'conversation-1',
  });
  newHarness.submit();

  assert.equal(newHarness.mode, 'chat');
  assert.equal(newHarness.studioConversationId, null);
  assert.deepEqual(newHarness.sent, ['new']);
});

test('submitCurrentInputFromController opens global review policy picker for /policy', () => {
  const harness = createSubmitHarness({ inputValue: '/policy' });

  harness.submit();

  assert.equal(harness.policyOpened(), true);
  assert.deepEqual(harness.sent, ['policy', 'clear']);
});

test('submitCurrentInputFromController opens workspace picker for /workspace', () => {
  const harness = createSubmitHarness({ inputValue: '/workspace' });

  harness.submit();

  assert.deepEqual(harness.sent, ['workspace', 'clear']);
});

test('submitCurrentInputFromController reports missing external editor hook', () => {
  const harness = createSubmitHarness({ inputValue: '/edit' });

  harness.submit();

  assert.deepEqual(harness.sent, ['clear']);
  assert.equal(harness.messages.length, 1);
});
