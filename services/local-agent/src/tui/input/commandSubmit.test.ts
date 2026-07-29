import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCurrentInputFromController } from './commandSubmit';
import type { TuiAction } from '../state/tuiState';

function createSubmitHarness(overrides: {
  inputValue?: string;
  openExternalEditor?: (initialText: string) => void;
  composerTarget?: 'chat' | 'studio';
  studioConversationId?: string | null;
} = {}) {
  const messages: string[] = [];
  const actions: TuiAction[] = [];
  const sent: string[] = [];
  let composerTarget = overrides.composerTarget ?? 'chat';
  let studioConversationId = overrides.studioConversationId ?? null;
  return {
    messages,
    actions,
    sent,
    get composerTarget() {
      return composerTarget;
    },
    get studioConversationId() {
      return studioConversationId;
    },
    policyOpened: () => sent.includes('policy'),
    transcriptOpened: () => sent.includes('transcript'),
    submit: () => submitCurrentInputFromController({
      inputValue: overrides.inputValue ?? '',
      focusedSession: null,
      composerTarget,
      studioConversationId,
      selectStudioComposerTarget: (conversationId) => {
        composerTarget = 'studio';
        studioConversationId = conversationId;
      },
      selectChatComposerTarget: () => {
        composerTarget = 'chat';
        studioConversationId = null;
      },
      openResumePicker: () => sent.push('resume'),
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

test('submitCurrentInputFromController selects the studio composer target with one conversation id', () => {
  const harness = createSubmitHarness({ inputValue: '/studio plan' });

  harness.submit();

  assert.equal(harness.composerTarget, 'studio');
  assert.equal(typeof harness.studioConversationId, 'string');
  assert.deepEqual(harness.actions.map((action) => action.type), ['session.configured']);
  assert.deepEqual(harness.sent, [`studio:${harness.studioConversationId}`]);
});

test('submitCurrentInputFromController selects the chat composer target for /chat', () => {
  const harness = createSubmitHarness({
    inputValue: '/chat',
    composerTarget: 'studio',
    studioConversationId: 'conversation-1',
  });

  harness.submit();

  assert.equal(harness.composerTarget, 'chat');
  assert.equal(harness.studioConversationId, null);
  assert.deepEqual(harness.actions.map((action) => action.type), ['session.configured']);
  assert.deepEqual(harness.sent, ['clear']);
});

test('submitCurrentInputFromController sends explicit delegation continuation', () => {
  const harness = createSubmitHarness({
    inputValue: '/continue apply the new constraints',
    composerTarget: 'studio',
    studioConversationId: 'conversation-1',
  });

  harness.submit();

  assert.equal(harness.composerTarget, 'chat');
  assert.equal(harness.studioConversationId, null);
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

test('submitCurrentInputFromController resets the composer target before /resume and /new', () => {
  const resumeHarness = createSubmitHarness({
    inputValue: '/resume',
    composerTarget: 'studio',
    studioConversationId: 'conversation-1',
  });
  resumeHarness.submit();

  assert.equal(resumeHarness.composerTarget, 'chat');
  assert.equal(resumeHarness.studioConversationId, null);
  assert.deepEqual(resumeHarness.actions.map((action) => action.type), ['session.configured']);
  assert.deepEqual(resumeHarness.sent, ['resume', 'clear']);

  const newHarness = createSubmitHarness({
    inputValue: '/new',
    composerTarget: 'studio',
    studioConversationId: 'conversation-1',
  });
  newHarness.submit();

  assert.equal(newHarness.composerTarget, 'chat');
  assert.equal(newHarness.studioConversationId, null);
  assert.deepEqual(newHarness.sent, ['new']);
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
