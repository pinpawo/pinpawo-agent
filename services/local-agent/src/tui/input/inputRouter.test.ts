import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTuiInputAction,
  resolveTuiInputCommand,
  resolveTuiInputOwner,
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
    { type: 'global.ctrl_c' },
  );
});

test('resolveTuiInputCommand routes resume picker commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'resumePicker' }),
    { type: 'resume.previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'resumePicker' }),
    { type: 'resume.next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'resumePicker' }),
    { type: 'resume.submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'resumePicker' }),
    { type: 'resume.dismiss' },
  );
});

test('resolveTuiInputCommand routes approval commands and free text edits', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'approval' }),
    { type: 'approval.previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'approval' }),
    { type: 'approval.submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'approval' }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'reason' }, { type: 'approval' }),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'unknown.control', raw: '\x1b[1;2A' }, { type: 'approval' }),
    { type: 'none' },
  );
});

test('resolveTuiInputCommand routes busy and composer commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'busy' }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'x' }, { type: 'busy' }),
    { type: 'none' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'composer' }),
    { type: 'composer.clear' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'composer' }),
    { type: 'composer.submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.delete.forward' }, { type: 'composer' }),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'tab', shift: true }, { type: 'composer' }),
    { type: 'none' },
  );
});
