import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTuiCommandHelp,
  listTuiCommands,
  parseTuiCommand,
} from './tui/input/commandRegistry';
import {
  applyComposerInput,
  createInitialTuiInputBufferState,
  normalizeTuiInputEvent,
  resolveTuiKeyAction,
  type ComposerInputState,
  type TuiKeyInput,
} from './tui/input/keymap';

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
    '/new 新会话 · /studio [任务] 进入 Studio 模式 · /chat 退出 Studio · /help · /export [path] 导出 transcript(默认当前目录) · /resume 恢复会话 · /quit',
  );
});

test('resolveTuiKeyAction routes global, approval, busy, and composer keys', () => {
  assert.deepEqual(
    resolveTuiKeyAction('c', { ctrl: true }, { ready: false, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'global.ctrl_c' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { upArrow: true }, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'approval.previous' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'approval.submit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('x', {}, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: true, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'composer.clear' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'composer.submit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { downArrow: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: true }),
    { type: 'resume.next' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: true }),
    { type: 'resume.submit' },
  );
});

test('resolveTuiKeyAction treats raw return input as submit', () => {
  const readyContext = {
    ready: true,
    busy: false,
    hasPendingApproval: false,
    hasResumePicker: false,
  };
  const rawReturnInputs = ['\r', '\n', '\r\n'];

  for (const input of rawReturnInputs) {
    assert.deepEqual(
      resolveTuiKeyAction(input, {}, readyContext),
      { type: 'composer.submit' },
    );
    assert.deepEqual(
      resolveTuiKeyAction(input, {}, { ...readyContext, hasPendingApproval: true }),
      { type: 'approval.submit' },
    );
    assert.deepEqual(
      resolveTuiKeyAction(input, {}, { ...readyContext, hasResumePicker: true }),
      { type: 'resume.submit' },
    );
  }
});

test('resolveTuiKeyAction treats Shift+Enter as composer edit newline', () => {
  const readyContext = {
    ready: true,
    busy: false,
    hasPendingApproval: false,
    hasResumePicker: false,
  };

  assert.deepEqual(
    resolveTuiKeyAction('', { return: true, shift: true }, readyContext),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('\x1b[13;2u', {}, readyContext),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('[27;2;13~', {}, readyContext),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('\x1b[13;2u', {}, { ...readyContext, hasPendingApproval: true }),
    { type: 'composer.edit' },
  );
});

test('resolveTuiKeyAction ignores unrelated terminal control sequences', () => {
  assert.deepEqual(
    resolveTuiKeyAction('\x1b[1;2A', {}, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'none' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('[1;2A', {}, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'none' },
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

test('applyComposerInput keeps cursor editing behavior in pure input reducer', () => {
  let state: ComposerInputState = { value: 'helo', cursorOffset: 2 };
  state = applyComposerInput('l', {}, state);
  assert.deepEqual(state, { value: 'hello', cursorOffset: 3 });

  state = applyComposerInput('', { leftArrow: true }, state);
  assert.deepEqual(state, { value: 'hello', cursorOffset: 2 });

  state = applyComposerInput('', { backspace: true }, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 1 });

  state = applyComposerInput('e', { ctrl: true }, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 4 });

  state = applyComposerInput('', { ctrl: true } as TuiKeyInput, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 4 });

  state = { value: 'run shell command', cursorOffset: 'run shell'.length };
  assert.deepEqual(applyComposerInput('w', { ctrl: true }, state), {
    value: 'run  command',
    cursorOffset: 4,
  });
});

test('applyComposerInput inserts Shift+Enter newline and normalizes pasted multiline text', () => {
  assert.deepEqual(
    applyComposerInput('', { return: true, shift: true }, { value: 'hello', cursorOffset: 5 }),
    { value: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    applyComposerInput('\x1b[13;2u', {}, { value: 'hello', cursorOffset: 5 }),
    { value: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    applyComposerInput('[27;2;13~', {}, { value: 'hello', cursorOffset: 5 }),
    { value: 'hello\n', cursorOffset: 6 },
  );
  assert.deepEqual(
    applyComposerInput('a\r\nb\rc', {}, { value: '', cursorOffset: 0 }),
    { value: 'a\nb\nc', cursorOffset: 5 },
  );
  assert.deepEqual(
    applyComposerInput('\x1b[200~a\r\nb\x1b[201~', {}, { value: '', cursorOffset: 0 }),
    { value: 'a\nb', cursorOffset: 3 },
  );
});
