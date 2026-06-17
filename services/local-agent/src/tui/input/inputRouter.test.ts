import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveLegacyTuiInputAction,
  resolveTuiInputAction,
  resolveTuiInputCommand,
  resolveTuiInputOwner,
  toLegacyTuiInputCommand,
} from './inputRouter';

test('resolveTuiInputOwner applies TUI focus priority', () => {
  assert.deepEqual(
    resolveTuiInputOwner({ ready: false, busy: true, hasPendingApproval: true, hasResumePicker: true }),
    { type: 'unready' },
  );
  assert.deepEqual(
    resolveTuiInputOwner({ ready: true, busy: true, hasPendingApproval: true, hasResumePicker: true }),
    { type: 'resumePicker' },
  );
  assert.deepEqual(
    resolveTuiInputOwner({ ready: true, busy: true, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'approval' },
  );
  assert.deepEqual(
    resolveTuiInputOwner({ ready: true, busy: true, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'busy' },
  );
  assert.deepEqual(
    resolveTuiInputOwner({ ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'composer' },
  );
});

test('resolveTuiInputAction keeps Ctrl+C global before owner routing', () => {
  assert.deepEqual(
    resolveTuiInputAction(
      { type: 'interrupt' },
      { ready: false, busy: false, hasPendingApproval: false, hasResumePicker: false },
    ),
    { target: 'global', action: 'ctrl_c' },
  );
});

test('resolveTuiInputCommand routes resume picker commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'resumePicker' }),
    { target: 'resume', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'resumePicker' }),
    { target: 'resume', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'resumePicker' }),
    { target: 'resume', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'resumePicker' }),
    { target: 'resume', action: 'dismiss' },
  );
});

test('resolveTuiInputCommand routes approval commands and free text edits', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'approval' }),
    { target: 'approval', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'approval' }),
    { target: 'approval', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'approval' }),
    { target: 'global', action: 'interrupt' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'reason' }, { type: 'approval' }),
    { target: 'textarea', command: { type: 'insert', text: 'reason' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'unknown.control', raw: '\x1b[1;2A' }, { type: 'approval' }),
    { target: 'none' },
  );
});

test('resolveTuiInputCommand routes busy and composer commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'busy' }),
    { target: 'global', action: 'interrupt' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'x' }, { type: 'busy' }),
    { target: 'none' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'composer' }),
    { target: 'composer', action: 'clear' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'composer' }),
    { target: 'composer', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.delete.forward' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'deleteForward' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'newline' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'newline' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'moveDown' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand(
      { type: 'cursor.up' },
      { type: 'composer' },
      {
        composerHistory: {
          boundary: { previous: true, next: true },
          available: { previous: false, next: true },
        },
      },
    ),
    { target: 'textarea', command: { type: 'moveUp' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'tab', shift: true }, { type: 'composer' }),
    { target: 'none' },
  );
});

test('resolveTuiInputCommand routes composer history only at textarea boundaries', () => {
  assert.deepEqual(
    resolveTuiInputCommand(
      { type: 'cursor.up' },
      { type: 'composer' },
      {
        composerHistory: {
          boundary: { previous: true, next: true },
          available: { previous: true, next: false },
        },
      },
    ),
    { target: 'composerHistory', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand(
      { type: 'cursor.down' },
      { type: 'composer' },
      {
        composerHistory: {
          boundary: { previous: true, next: true },
          available: { previous: false, next: true },
        },
      },
    ),
    { target: 'composerHistory', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand(
      { type: 'cursor.up' },
      { type: 'composer' },
      {
        composerHistory: {
          boundary: { previous: false, next: true },
          available: { previous: true, next: true },
        },
      },
    ),
    { target: 'textarea', command: { type: 'moveUp' } },
  );
});

test('legacy input command conversion keeps keymap compatibility shape', () => {
  assert.deepEqual(
    toLegacyTuiInputCommand({ target: 'textarea', command: { type: 'deleteForward' } }),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    toLegacyTuiInputCommand({ target: 'composerHistory', action: 'previous' }),
    { type: 'composer.history.previous' },
  );
  assert.deepEqual(
    resolveLegacyTuiInputAction(
      { type: 'submit' },
      { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false },
    ),
    { type: 'approval.submit' },
  );
});
