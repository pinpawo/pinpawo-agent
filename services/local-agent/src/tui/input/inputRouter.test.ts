import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTuiInputAction,
  resolveTuiInputCommand,
} from './inputRouter';

test('resolveTuiInputAction leaves external editor input owned by the editor', () => {
  assert.deepEqual(
    resolveTuiInputAction(
      { type: 'interrupt' },
      { type: 'externalEditor' },
    ),
    { target: 'none' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'x' }, { type: 'externalEditor' }),
    { target: 'none' },
  );
});

test('resolveTuiInputAction keeps Ctrl+C global before owner routing', () => {
  assert.deepEqual(
    resolveTuiInputAction(
      { type: 'interrupt' },
      { type: 'unready' },
    ),
    { target: 'global', action: 'ctrl_c' },
  );
});

test('resolveTuiInputCommand routes transcript viewer navigation', () => {
  const owner = { type: 'transcriptViewer' } as const;
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, owner),
    { target: 'transcript', action: 'line_up' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'viewport.scroll.down' }, owner),
    { target: 'transcript', action: 'line_down' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'viewport.page.up' }, owner),
    { target: 'transcript', action: 'page_up' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.line.start' }, owner),
    { target: 'transcript', action: 'top' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.line.end' }, owner),
    { target: 'transcript', action: 'bottom' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'q' }, owner),
    { target: 'transcript', action: 'dismiss' },
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

test('resolveTuiInputCommand routes global review policy picker commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'globalReviewPolicyPicker' }),
    { target: 'globalReviewPolicy', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'globalReviewPolicyPicker' }),
    { target: 'globalReviewPolicy', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'globalReviewPolicyPicker' }),
    { target: 'globalReviewPolicy', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'globalReviewPolicyPicker' }),
    { target: 'globalReviewPolicy', action: 'dismiss' },
  );
});

test('resolveTuiInputCommand routes model profile picker commands', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'modelProfilePicker' }),
    { target: 'modelProfile', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'modelProfilePicker' }),
    { target: 'modelProfile', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'modelProfilePicker' }),
    { target: 'modelProfile', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, { type: 'modelProfilePicker' }),
    { target: 'modelProfile', action: 'dismiss' },
  );
});

test('resolveTuiInputCommand routes approval commands and free text edits', () => {
  const approvalOwner = { type: 'approval', freeTextActive: false } as const;
  const activeFreeTextApprovalOwner = { type: 'approval', freeTextActive: true } as const;

  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, approvalOwner),
    { target: 'approval', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, activeFreeTextApprovalOwner),
    { target: 'textarea', command: { type: 'moveDown' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'selection.up' }, activeFreeTextApprovalOwner),
    { target: 'textarea', command: { type: 'selectUp' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'selection.down' }, activeFreeTextApprovalOwner),
    { target: 'textarea', command: { type: 'selectDown' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, approvalOwner),
    { target: 'approval', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, activeFreeTextApprovalOwner),
    { target: 'approval', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'escape' }, approvalOwner),
    { target: 'global', action: 'interrupt' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'reason' }, approvalOwner),
    { target: 'textarea', command: { type: 'insert', text: 'reason' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'unknown.control', raw: '\x1b[1;2A' }, approvalOwner),
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
    resolveTuiInputCommand({ type: 'edit.undo' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'undo' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'edit.redo' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'redo' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'edit.select.all' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'selectAll' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'moveDown' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'selection.down' }, { type: 'composer' }),
    { target: 'textarea', command: { type: 'selectDown' } },
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
    resolveTuiInputCommand(
      { type: 'selection.up' },
      { type: 'composer' },
      {
        composerHistory: {
          boundary: { previous: true, next: true },
          available: { previous: true, next: true },
        },
      },
    ),
    { target: 'textarea', command: { type: 'selectUp' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'tab', shift: true }, { type: 'composer' }),
    { target: 'none' },
  );
});

test('resolveTuiInputCommand routes file mention popup commands before composer editing', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'fileMention' }),
    { target: 'fileMention', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'fileMention' }),
    { target: 'fileMention', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'tab', shift: false }, { type: 'fileMention' }),
    { target: 'fileMention', action: 'accept' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'fileMention' }),
    { target: 'fileMention', action: 'accept' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.delete.backward' }, { type: 'fileMention' }),
    { target: 'textarea', command: { type: 'deleteBackward' } },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 's' }, { type: 'fileMention' }),
    { target: 'textarea', command: { type: 'insert', text: 's' } },
  );
});

test('resolveTuiInputCommand routes command palette commands before composer editing', () => {
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.up' }, { type: 'commandPalette' }),
    { target: 'commandPalette', action: 'previous' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'cursor.down' }, { type: 'commandPalette' }),
    { target: 'commandPalette', action: 'next' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'tab', shift: false }, { type: 'commandPalette' }),
    { target: 'commandPalette', action: 'accept' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'submit' }, { type: 'commandPalette' }),
    { target: 'commandPalette', action: 'submit' },
  );
  assert.deepEqual(
    resolveTuiInputCommand({ type: 'text.insert', text: 'n' }, { type: 'commandPalette' }),
    { target: 'textarea', command: { type: 'insert', text: 'n' } },
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
