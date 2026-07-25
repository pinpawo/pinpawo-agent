import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTuiCommandHelp,
  listTuiCommands,
  parseTuiCommand,
} from './tui/input/commandRegistry';
import {
  createInitialTuiInputBufferState,
  normalizeTuiInputEvent,
  resolveTuiInteractionOwner,
  resolveTuiInputAction,
  toCanonicalInputEvent,
  type TuiInteractionState,
  type TuiKeyInput,
} from './tui/input/keymap';
import {
  applyTextAreaCommand,
  renderTextAreaRows,
  toTextAreaCommand,
  wrapTextAreaRows,
  type TextAreaModel,
} from './tui/input/textareaModel';
import type { TextAreaCommand } from './tui/input/textareaModel';

function resolveRawTuiInputAction(
  input: string,
  key: TuiKeyInput,
  state: TuiInteractionState,
) {
  return resolveTuiInputAction(
    toCanonicalInputEvent({ input, key }),
    resolveTuiInteractionOwner(state),
  );
}

function commandFromRawInput(input: string, key: TuiKeyInput): TextAreaCommand {
  const command = toTextAreaCommand(toCanonicalInputEvent({ input, key }));
  assert.notEqual(command, null);
  return command!;
}

test('parseTuiCommand parses text, aliases, args, and unknown commands', () => {
  assert.deepEqual(parseTuiCommand('hello'), {
    type: 'text',
    text: 'hello',
  });
  assert.deepEqual(parseTuiCommand('/'), {
    type: 'command',
    command: listTuiCommands().find((command) => command.name === 'help'),
    name: 'help',
    raw: '/',
    args: '',
  });

  const studio = parseTuiCommand('/studio build a poster');
  assert.equal(studio.type, 'command');
  assert.equal(studio.type === 'command' ? studio.name : null, 'studio');
  assert.equal(studio.type === 'command' ? studio.args : null, 'build a poster');

  const exit = parseTuiCommand('/exit');
  assert.equal(exit.type, 'command');
  assert.equal(exit.type === 'command' ? exit.name : null, 'quit');

  const exportCommand = parseTuiCommand('/export transcripts/today.md');
  assert.equal(exportCommand.type, 'command');
  assert.equal(exportCommand.type === 'command' ? exportCommand.name : null, 'export');
  assert.equal(exportCommand.type === 'command' ? exportCommand.args : null, 'transcripts/today.md');

  const resumeCommand = parseTuiCommand('/resume');
  assert.equal(resumeCommand.type, 'command');
  assert.equal(resumeCommand.type === 'command' ? resumeCommand.name : null, 'resume');

  const editCommand = parseTuiCommand('/edit draft text');
  assert.equal(editCommand.type, 'command');
  assert.equal(editCommand.type === 'command' ? editCommand.name : null, 'edit');
  assert.equal(editCommand.type === 'command' ? editCommand.args : null, 'draft text');

  assert.deepEqual(parseTuiCommand('/studiox'), {
    type: 'unknown',
    raw: '/studiox',
    name: 'studiox',
    args: '',
  });
});

test('parseTuiCommand treats slash-prefixed non-command shapes as plain text', () => {
  // Absolute paths must reach the agent unchanged, not surface "unknown
  // command" feedback that swallows the message.
  assert.deepEqual(
    parseTuiCommand('/Users/wangxianbin/Develop/src/hughub/ look at this'),
    { type: 'text', text: '/Users/wangxianbin/Develop/src/hughub/ look at this' },
  );
  assert.deepEqual(parseTuiCommand('/etc/hosts'), {
    type: 'text',
    text: '/etc/hosts',
  });
  // Double slash and leading-non-letter forms also fall through to chat.
  assert.deepEqual(parseTuiCommand('//comment'), {
    type: 'text',
    text: '//comment',
  });
  assert.deepEqual(parseTuiCommand('/123abc'), {
    type: 'text',
    text: '/123abc',
  });
  // /<name>-<rest> is still a valid command-name shape (kebab-case names
  // could be added later); preserve as unknown so feedback still fires.
  assert.deepEqual(parseTuiCommand('/foo-bar'), {
    type: 'unknown',
    raw: '/foo-bar',
    name: 'foo-bar',
    args: '',
  });
});

test('formatTuiCommandHelp is generated from visible command metadata', () => {
  assert.equal(
    formatTuiCommandHelp(),
    '/new 新会话 · /studio [任务] 进入 Studio 模式 · /chat 退出 Studio · /policy 选择授权策略 · /help · /transcript 浏览历史 · /export [path] 导出 transcript(默认当前目录) · /edit [文本] 外部编辑 · /resume 恢复会话 · /quit',
  );
});

test('resolveTuiInputAction routes global, approval, busy, and composer keys', () => {
  assert.deepEqual(
    resolveRawTuiInputAction('c', { ctrl: true }, { ready: false, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'global', action: 'ctrl_c' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { upArrow: true }, { ready: true, busy: false, pendingApproval: true, resumePickerOpen: false }),
    { target: 'approval', action: 'previous' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { return: true }, { ready: true, busy: false, pendingApproval: true, resumePickerOpen: false }),
    { target: 'approval', action: 'submit' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('x', {}, { ready: true, busy: false, pendingApproval: true, resumePickerOpen: false }),
    { target: 'textarea', command: { type: 'insert', text: 'x' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { escape: true }, { ready: true, busy: false, pendingApproval: true, resumePickerOpen: false }),
    { target: 'global', action: 'interrupt' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { escape: true }, { ready: true, busy: true, pendingApproval: false, resumePickerOpen: false }),
    { target: 'global', action: 'interrupt' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { escape: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'composer', action: 'clear' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { return: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'composer', action: 'submit' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { upArrow: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'textarea', command: { type: 'moveUp' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { downArrow: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: true }),
    { target: 'resume', action: 'next' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { pageUp: true }, { ready: true, busy: true, pendingApproval: false, resumePickerOpen: false }),
    { target: 'timeline', action: 'page_up' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('[<65;20;10M', {}, {
      ready: true,
      busy: false,
      pendingApproval: false,
      resumePickerOpen: false,
    }),
    { target: 'timeline', action: 'scroll_down' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { pageUp: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: true }),
    { target: 'resume', action: 'previous' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('[<64;20;10M', {}, {
      ready: true,
      busy: false,
      pendingApproval: false,
      resumePickerOpen: true,
    }),
    { target: 'resume', action: 'previous' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { pageDown: true }, {
      ready: true,
      busy: false,
      pendingApproval: true,
      resumePickerOpen: false,
    }),
    { target: 'approval', action: 'next' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { pageUp: true }, {
      ready: true,
      busy: false,
      pendingApproval: false,
      resumePickerOpen: false,
      commandPaletteOpen: true,
    }),
    { target: 'commandPalette', action: 'previous' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { pageDown: true }, {
      ready: true,
      busy: false,
      pendingApproval: false,
      resumePickerOpen: false,
      fileMentionOpen: true,
    }),
    { target: 'fileMention', action: 'next' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { return: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: true }),
    { target: 'resume', action: 'submit' },
  );
});

test('resolveTuiInputAction treats raw return input as submit', () => {
  const readyContext = {
    ready: true,
    busy: false,
    pendingApproval: false,
    resumePickerOpen: false,
  };
  const rawReturnInputs = ['\r', '\n', '\r\n'];

  for (const input of rawReturnInputs) {
    assert.deepEqual(
      resolveRawTuiInputAction(input, {}, readyContext),
      { target: 'composer', action: 'submit' },
    );
    assert.deepEqual(
      resolveRawTuiInputAction(input, {}, { ...readyContext, pendingApproval: true }),
      { target: 'approval', action: 'submit' },
    );
    assert.deepEqual(
      resolveRawTuiInputAction(input, {}, { ...readyContext, resumePickerOpen: true }),
      { target: 'resume', action: 'submit' },
    );
  }
});

test('resolveTuiInputAction treats Shift+Enter as composer edit newline', () => {
  const readyContext = {
    ready: true,
    busy: false,
    pendingApproval: false,
    resumePickerOpen: false,
  };

  assert.deepEqual(
    resolveRawTuiInputAction('', { return: true, shift: true }, readyContext),
    { target: 'textarea', command: { type: 'newline' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('\x1b[13;2u', {}, readyContext),
    { target: 'textarea', command: { type: 'newline' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('[27;2;13~', {}, readyContext),
    { target: 'textarea', command: { type: 'newline' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('\x1b[13;2u', {}, { ...readyContext, pendingApproval: true }),
    { target: 'textarea', command: { type: 'newline' } },
  );
});

test('resolveTuiInputAction ignores unrelated terminal control sequences', () => {
  assert.deepEqual(
    resolveRawTuiInputAction('\x1b[1;3A', {}, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'none' },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('[1;3A', {}, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'none' },
  );
});

test('resolveTuiInputAction treats Shift+Arrow as composer selection edit', () => {
  assert.deepEqual(
    resolveRawTuiInputAction('\x1b[1;2A', {}, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'textarea', command: { type: 'selectUp' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('', { leftArrow: true, shift: true }, { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false }),
    { target: 'textarea', command: { type: 'selectLeft' } },
  );
});

test('resolveTuiInputAction treats undo and redo controls as composer edits', () => {
  const readyContext = { ready: true, busy: false, pendingApproval: false, resumePickerOpen: false };

  assert.deepEqual(
    resolveRawTuiInputAction('z', { ctrl: true }, readyContext),
    { target: 'textarea', command: { type: 'undo' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('z', { ctrl: true, shift: true }, readyContext),
    { target: 'textarea', command: { type: 'redo' } },
  );
  assert.deepEqual(
    resolveRawTuiInputAction('y', { ctrl: true }, readyContext),
    { target: 'textarea', command: { type: 'redo' } },
  );
});

test('normalizeTuiInputEvent buffers split terminal control sequences', () => {
  let state = createInitialTuiInputBufferState();
  let normalized = normalizeTuiInputEvent('[2', {}, state);
  assert.equal(normalized.event, null);
  state = normalized.state;

  normalized = normalizeTuiInputEvent('7;2;13~', {}, state);
  assert.deepEqual(normalized.event, { input: '[27;2;13~', key: {} });
  state = normalized.state;

  normalized = normalizeTuiInputEvent('x', {}, state);
  assert.deepEqual(normalized.event, { input: 'x', key: {} });
});

test('applyTextAreaCommand keeps cursor editing behavior in pure input reducer', () => {
  let state: TextAreaModel = { text: 'helo', cursorOffset: 2 };
  state = applyTextAreaCommand({ type: 'insert', text: 'l' }, state);
  assert.deepEqual(withoutEditHistory(state), { text: 'hello', cursorOffset: 3 });

  state = applyTextAreaCommand({ type: 'moveLeft' }, state);
  assert.deepEqual(withoutEditHistory(state), { text: 'hello', cursorOffset: 2 });

  state = applyTextAreaCommand({ type: 'deleteBackward' }, state);
  assert.deepEqual(withoutEditHistory(state), { text: 'hllo', cursorOffset: 1 });

  state = applyTextAreaCommand({ type: 'moveLineEnd' }, state);
  assert.deepEqual(withoutEditHistory(state), { text: 'hllo', cursorOffset: 4 });

  state = { text: 'run shell command', cursorOffset: 'run shell'.length };
  assert.deepEqual(withoutEditHistory(applyTextAreaCommand({ type: 'deleteWordBackward' }, state)), {
    text: 'run  command',
    cursorOffset: 4,
  });
});

test('canonical-to-command path inserts Shift+Enter newline and normalizes pasted multiline text', () => {
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('', { return: true, shift: true }), { text: 'hello', cursorOffset: 5 })),
    { text: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('\x1b[13;2u', {}), { text: 'hello', cursorOffset: 5 })),
    { text: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('[27;2;13~', {}), { text: 'hello', cursorOffset: 5 })),
    { text: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('a\r\nb\rc', {}), { text: '', cursorOffset: 0 })),
    { text: 'a\nb\nc', cursorOffset: 5 },
  );
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('\x1b[200~a\r\nb\x1b[201~', {}), { text: '', cursorOffset: 0 })),
    { text: 'a\nb', cursorOffset: 3 },
  );
});

test('canonical-to-command path supports textarea delete and line movement operations', () => {
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('', { delete: true }), { text: 'abc', cursorOffset: 1 })),
    { text: 'bc', cursorOffset: 0 },
  );
  assert.deepEqual(
    withoutEditHistory(applyTextAreaCommand(commandFromRawInput('\x1b[3~', {}), { text: 'abc', cursorOffset: 1 })),
    { text: 'ac', cursorOffset: 1 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'selectAll' }, { text: 'one\ntwo three', cursorOffset: 8 }),
    {
      text: 'one\ntwo three',
      cursorOffset: 13,
      selection: { anchorOffset: 0, focusOffset: 13 },
    },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveLineEnd' }, { text: 'one\ntwo three', cursorOffset: 8 }),
    { text: 'one\ntwo three', cursorOffset: 13 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveLineStart' }, { text: 'one\ntwo three', cursorOffset: 8 }),
    { text: 'one\ntwo three', cursorOffset: 4 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveLineEnd' }, { text: 'one\ntwo three', cursorOffset: 8 }),
    { text: 'one\ntwo three', cursorOffset: 13 },
  );
});

test('applyTextAreaCommand supports undo and redo controls', () => {
  let state = applyTextAreaCommand({ type: 'insert', text: '!' }, { text: 'hi', cursorOffset: 2 });
  state = applyTextAreaCommand({ type: 'undo' }, state);
  assert.deepEqual(state, {
    text: 'hi',
    cursorOffset: 2,
    editHistory: {
      undo: [],
      redo: [{ text: 'hi!', cursorOffset: 3 }],
    },
  });

  state = applyTextAreaCommand({ type: 'redo' }, state);
  assert.deepEqual(state, {
    text: 'hi!',
    cursorOffset: 3,
    editHistory: {
      undo: [{ text: 'hi', cursorOffset: 2 }],
      redo: [],
    },
  });
});

test('applyTextAreaCommand moves cursor across wrapped and multiline rows', () => {
  const text = 'abcdef\ngh';

  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveUp' }, { text, cursorOffset: 4 }, { width: 3 }),
    { text, cursorOffset: 1, preferredColumn: 1 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveDown' }, { text, cursorOffset: 1 }, { width: 3 }),
    { text, cursorOffset: 4, preferredColumn: 1 },
  );
  assert.deepEqual(
    applyTextAreaCommand({ type: 'moveDown' }, { text, cursorOffset: 5 }, { width: 3 }),
    { text, cursorOffset: 9, preferredColumn: 2 },
  );
});

test('textarea render rows preserve long pasted text and place cursor in wrapped content', () => {
  const text = 'abcdef\nghij';
  assert.deepEqual(
    wrapTextAreaRows(text, 3).map((row) => row.text),
    ['abc', 'def', 'ghi', 'j'],
  );

  assert.deepEqual(
    renderTextAreaRows({ text, cursorOffset: 4 }, 3).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
    })),
    [
      { before: 'abc', cursor: null, after: '' },
      { before: 'd', cursor: 'e', after: 'f' },
      { before: 'ghi', cursor: null, after: '' },
      { before: 'j', cursor: null, after: '' },
    ],
  );
});

function withoutEditHistory<T extends { editHistory?: unknown }>(state: T): Omit<T, 'editHistory'> {
  const { editHistory: _editHistory, ...rest } = state;
  return rest;
}
