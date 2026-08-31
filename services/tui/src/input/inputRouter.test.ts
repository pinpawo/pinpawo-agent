import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureInteractionInputFocus,
  interactionOwnerBlocksPaste,
  resolveInteractionOwner,
  type InteractionOwnerState,
} from './inputRouter';

const IDLE: InteractionOwnerState = {
  approval: {
    open: false,
    acceptsTextInput: false,
  },
  noticeOpen: false,
  policyPickerOpen: false,
  commandHelpOpen: false,
  sessionPickerOpen: false,
  commandPaletteOpen: false,
  fileMentionOpen: false,
};

test('interaction owner uses one explicit overlay precedence', () => {
  assert.deepEqual(resolveInteractionOwner(IDLE), {
    type: 'composer',
  });
  assert.deepEqual(resolveInteractionOwner({
    ...IDLE,
    fileMentionOpen: true,
    commandPaletteOpen: true,
  }), {
    type: 'command-palette',
  });
  assert.deepEqual(resolveInteractionOwner({
    ...IDLE,
    fileMentionOpen: true,
    commandPaletteOpen: true,
    sessionPickerOpen: true,
    commandHelpOpen: true,
    policyPickerOpen: true,
    modelPickerOpen: true,
    noticeOpen: true,
    approval: {
      open: true,
      acceptsTextInput: false,
    },
  }), {
    type: 'approval',
    acceptsTextInput: false,
  });
});

test('paste reaches only composer-like or free-text owners', () => {
  assert.equal(interactionOwnerBlocksPaste({
    type: 'approval',
    acceptsTextInput: true,
  }), false);
  assert.equal(interactionOwnerBlocksPaste({
    type: 'approval',
    acceptsTextInput: false,
  }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'notice' }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'policy-picker' }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'model-picker' }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'command-help' }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'session-picker' }), true);
  assert.equal(interactionOwnerBlocksPaste({ type: 'command-palette' }), false);
  assert.equal(interactionOwnerBlocksPaste({ type: 'file-mention' }), false);
  assert.equal(interactionOwnerBlocksPaste({ type: 'composer' }), false);
});

test('the current input owner repairs a lost editor focus', () => {
  const focused: string[] = [];
  const inputs = {
    composer: {
      focused: false,
      focus: () => focused.push('composer'),
    },
    approval: {
      focused: false,
      focus: () => focused.push('approval'),
    },
  };

  ensureInteractionInputFocus({ type: 'composer' }, inputs);
  ensureInteractionInputFocus({ type: 'command-palette' }, inputs);
  ensureInteractionInputFocus({ type: 'file-mention' }, inputs);
  ensureInteractionInputFocus({
    type: 'approval',
    acceptsTextInput: true,
  }, inputs);
  assert.deepEqual(focused, [
    'composer',
    'composer',
    'composer',
    'approval',
  ]);
});

test('non-input owners do not steal focus', () => {
  let focusCount = 0;
  const inputs = {
    composer: {
      focused: false,
      focus: () => focusCount += 1,
    },
    approval: {
      focused: false,
      focus: () => focusCount += 1,
    },
  };

  ensureInteractionInputFocus({ type: 'notice' }, inputs);
  ensureInteractionInputFocus({ type: 'session-picker' }, inputs);
  ensureInteractionInputFocus({
    type: 'approval',
    acceptsTextInput: false,
  }, inputs);
  assert.equal(focusCount, 0);
});
